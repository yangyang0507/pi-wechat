import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from '@mariozechner/pi-coding-agent';
import { AssistantMessage } from '@mariozechner/pi-ai';
import qrcode from 'qrcode-terminal';
import {
  clearCredentials,
  getCredentialsPath,
  getQrCode,
  loadCredentials,
  pollQrStatus,
  saveCredentials,
} from './auth.js';
import { resolveBuildSystemPrompt } from './config.js';
import { SessionExpiredError, WeixinClient } from './client.js';
import type { IncomingMessage, QueuedWechatRequest } from './types.js';
import { AgentMessage } from '@mariozechner/pi-agent-core/dist/types.js';

type NotificationLevel = 'info' | 'warning' | 'error';

const POLL_RETRY_BASE_MS = 1_000;
const POLL_RETRY_MAX_MS = 10_000;
const QR_POLL_INTERVAL_MS = 2_000;
const PREVIEW_LIMIT = 60;
const DEBUG_LOG = process.env.PI_WECHAT_DEBUG === '1';

export default function wechatExtension(pi: ExtensionAPI) {
  let client: WeixinClient | null = null;
  let pollAbortController: AbortController | null = null;
  let latestContext: ExtensionContext | null = null;

  const inboundQueue: QueuedWechatRequest[] = [];
  let pendingInjection: QueuedWechatRequest | null = null;
  let activeRequest: QueuedWechatRequest | null = null;
  let queueBarrierOpen: ((value: void | PromiseLike<void>) => void) | null =
    null;
  let agentBarrierOpen: ((value: void | PromiseLike<void>) => void) | null =
    null;
  let agentBarrier: Promise<void> | null = null;
  let queueBarrier: Promise<void> | null = new Promise((resolve) => {
    queueBarrierOpen = resolve;
  });

  function isRunning() {
    return pollAbortController != null;
  }

  function rememberContext(ctx: ExtensionContext): void {
    latestContext = ctx;
  }

  function notify(message: string, level: NotificationLevel = 'info'): void {
    if (latestContext?.hasUI) {
      latestContext.ui.notify(message, level);
      if (!DEBUG_LOG) {
        return;
      }
    }

    const printer = level === 'error' ? console.error : console.log;
    printer(`[wechat/${level}] ${message}`);
  }

  function loadClientFromDisk(): WeixinClient | null {
    const creds = loadCredentials();
    return creds ? new WeixinClient(creds) : null;
  }

  function ensureClient(): WeixinClient | null {
    return (client ??= loadClientFromDisk());
  }

  async function stopBridge(options?: {
    clearClient?: boolean;
    clearQueue?: boolean;
  }): Promise<void> {
    pollAbortController?.abort();
    pollAbortController = null;

    if (activeRequest && client) {
      await client.stopTyping(activeRequest.userId).catch(() => {});
    }

    if (options?.clearQueue !== false) {
      inboundQueue.length = 0;
    }

    pendingInjection = null;
    activeRequest = null;

    if (options?.clearClient) {
      client = null;
    }
  }

  function queueIncomingMessage(message: IncomingMessage): void {
    const request: QueuedWechatRequest = {
      id: randomUUID(),
      userId: message.userId,
      messageId: message.messageId,
      receivedAt: message.timestamp,
      text: message.text,
      preview: summarizePreview(message.text),
    };

    inboundQueue.push(request);
    queueBarrierOpen?.();
    if (DEBUG_LOG) {
      notify(`收到微信消息，已排队: ${request.preview}`, 'info');
    }
  }

  async function sendReply(userId: string, text: string): Promise<void> {
    await client?.sendTyping(userId).catch(() => {});
    await client?.sendText(userId, text);
  }

  async function drainQueue(ctx: ExtensionCommandContext): Promise<void> {
    if (!isRunning() || !client) {
      return;
    }

    await Promise.all([
      agentBarrier ?? Promise.resolve(),
      queueBarrier ?? Promise.resolve(),
    ]);

    const next = inboundQueue.shift();
    if (!next) {
      return;
    }

    if (inboundQueue.length === 0) {
      queueBarrier = new Promise((resolve) => {
        queueBarrierOpen = resolve;
      });
    }

    // Check if message starts with /new - start new session
    if (next.text.trim() === '/new') {
      try {
        latestContext = null;
        const result = await ctx.newSession();
        if (result.cancelled) {
          await sendReply(next.userId, '新会话已取消');
        } else {
          await sendReply(next.userId, '已开始新会话');
        }
      } catch (error) {
        await sendReply(next.userId, `启动新会话失败: ${formatError(error)}`);
      }
      drainQueue(ctx);
      return;
    }

    // Check if message starts with /model - handle model selection
    if (next.text.trim().startsWith('/model')) {
      const modelArgs = next.text.trim().slice(6).trim();

      if (modelArgs) {
        // Search for model by provider and/or model id
        const availableModels = ctx?.modelRegistry?.getAvailable() ?? [];

        // Parse input - could be "provider/id", "provider", or just partial name
        const slashIndex = modelArgs.indexOf('/');
        let searchTerm: string;
        let searchByProvider: boolean;

        if (slashIndex === -1) {
          // No slash, search by partial model name across all providers
          searchTerm = modelArgs.toLowerCase();
          searchByProvider = false;
        } else if (slashIndex === 0) {
          // Starts with slash, invalid
          await sendReply(
            next.userId,
            `模型格式错误，请使用 \`provider/model-id\` 格式`,
          );
          drainQueue(ctx);
          return;
        } else {
          // Has slash, split into provider and model-id
          searchTerm = modelArgs.toLowerCase();
          searchByProvider = true;
        }

        let matches: Array<{ provider: string; id: string; model: any }> = [];

        const providerToString = (m: { provider: string; id: string }) => ({
          provider: m.provider,
          id: m.id,
          model: m,
        });

        if (searchByProvider) {
          // Search with provider/model-id pattern
          const parts = modelArgs.split('/');
          const providerPart = parts[0].toLowerCase();
          const modelIdPart = parts.slice(1).join('/').toLowerCase();

          matches = availableModels
            .filter((m) => {
              const providerMatch = m.provider
                .toLowerCase()
                .includes(providerPart);
              const idMatch = modelIdPart
                ? m.id.toLowerCase().includes(modelIdPart)
                : true;
              return providerMatch && idMatch;
            })
            .map(providerToString);
        } else {
          // Search by partial model id/name across all providers
          matches = availableModels
            .filter((m) => m.id.toLowerCase().includes(searchTerm))
            .map(providerToString);
        }

        if (matches.length === 0) {
          await sendReply(
            next.userId,
            `未找到匹配的模型：\`${modelArgs}\`\n\n请使用 /model 查看可用模型列表`,
          );
        } else if (matches.length === 1) {
          const matched = matches[0];
          const fullModelName = `${matched.provider}/${matched.id}`;

          if (!(await pi.setModel(matched.model))) {
            await sendReply(next.userId, `设置模型失败`);
          }
        } else {
          // Multiple matches, list them
          const modelList = matches
            .slice(0, 10)
            .map((m) => `- ${m.provider}/${m.id}`)
            .join('\n');
          const extraInfo =
            matches.length > 10
              ? `\n\n还有 ${matches.length - 10} 个匹配...`
              : '';

          await sendReply(
            next.userId,
            `找到 ${matches.length} 个匹配的模型:\n\n${modelList}${extraInfo}\n\n请使用完整名称选择，如: \`${matches[0].provider}/${matches[0].id}\``,
          );
        }
      } else {
        // List available models using modelRegistry
        const models = ctx?.modelRegistry?.getAvailable() ?? [];
        if (models.length === 0) {
          await sendReply(next.userId, '没有已配置模型的可用模型');
        } else {
          const limitedModels = models.slice(0, 10);
          const modelList = limitedModels
            .map((m) => `${m.provider}/${m.id} (${m.name})`)
            .join('\n');
          const extraInfo =
            models.length > 10
              ? `\n\n还有 ${models.length - 10} 个模型...`
              : '';
          await sendReply(
            next.userId,
            `已配置模型:\n\n${modelList}${extraInfo}`,
          );
        }
      }

      drainQueue(ctx);
      return;
    }

    // Check if message starts with ! - run as shell command
    if (next.text.trim().startsWith('!')) {
      const commandLine = next.text.slice(1).trim();
      if (commandLine) {
        const parts = commandLine.split(/\s+/);
        const command = parts[0];
        const args = parts.slice(1);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30_000);

        try {
          const result = await pi.exec(command, args, {
            signal: controller.signal,
          });
          const output =
            result.stdout || result.stderr || `命令退出码：${result.code}`;
          await sendReply(next.userId, output.trim() || '(无输出)');
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          await sendReply(next.userId, `命令执行失败：${errorMessage}`);
        } finally {
          clearTimeout(timeoutId);
        }
      } else {
        await sendReply(next.userId, '错误：！后需要跟命令');
      }

      drainQueue(ctx);
      return;
    }

    agentBarrier = new Promise((resolve) => {
      agentBarrierOpen = resolve;
    });

    pendingInjection = next;
    void client.sendTyping(next.userId).catch(() => {});
    pi.sendUserMessage(next.text);
    drainQueue(ctx);
  }

  async function completeActiveRequest(
    messages: AgentMessage[],
  ): Promise<void> {
    const request = activeRequest;
    activeRequest = null;
    pendingInjection = null;

    if (!request || !client) {
      agentBarrierOpen?.();
      return;
    }

    const reply = extractFinalAssistantText(messages);

    try {
      if (reply) {
        await client.sendText(request.userId, reply);
      } else {
        notify(
          `Pi 没有产出可发送的文本回复，已跳过: ${request.preview}`,
          'warning',
        );
      }
    } catch (error) {
      notify(`发送微信回复失败: ${formatError(error)}`, 'error');
    } finally {
      await client.stopTyping(request.userId).catch(() => {});
      agentBarrierOpen?.();
    }
  }

  async function pollMessages(activeClient: WeixinClient): Promise<void> {
    let retryDelayMs = POLL_RETRY_BASE_MS;

    while (isRunning() && client === activeClient) {
      try {
        const messages = await activeClient.getUpdates(
          pollAbortController?.signal,
        );
        retryDelayMs = POLL_RETRY_BASE_MS;

        for (const message of messages) {
          queueIncomingMessage(message);
        }
      } catch (error) {
        if (isAbortError(error)) {
          break;
        }

        if (error instanceof SessionExpiredError) {
          notify('微信 session 已过期，请重新执行 /wechat-login', 'error');
          await stopBridge({ clearQueue: false });
          break;
        }

        await delay(retryDelayMs);
        retryDelayMs = Math.min(retryDelayMs * 2, POLL_RETRY_MAX_MS);
      }
    }
  }

  pi.registerCommand('wechat-login', {
    description: '扫码登录微信 iLink Bot',
    handler: async (args, ctx) => {
      const force = args.split(/\s+/).some((part) => part === '--force');
      if (!force) {
        const cached = loadClientFromDisk();
        if (cached) {
          client = cached;
          notify(`已加载本地微信凭证: ${getCredentialsPath()}`, 'info');
          return;
        }
      }

      if (isRunning()) {
        await stopBridge();
      }

      try {
        const qr = await getQrCode();
        const qrText = await renderQrCode(qr.url);
        notify(
          `请用微信扫码登录：\n\n${qrText}\n\n二维码链接：${qr.url}`,
          'info',
        );

        let lastStatus: 'wait' | 'scaned' | 'confirmed' | 'expired' | null =
          null;

        while (true) {
          await delay(QR_POLL_INTERVAL_MS);
          const result = await pollQrStatus(qr.token);

          if (result.status === lastStatus) {
            continue;
          }
          lastStatus = result.status;

          if (result.status === 'scaned') {
            notify('已扫码，请在手机上确认登录', 'info');
            continue;
          }

          if (result.status === 'confirmed' && result.credentials) {
            saveCredentials(result.credentials);
            client = new WeixinClient(result.credentials);
            notify('微信登录成功', 'info');
            return;
          }

          if (result.status === 'expired') {
            notify('二维码已过期，请重新执行 /wechat-login', 'error');
            return;
          }
        }
      } catch (error) {
        notify(`微信登录失败: ${formatError(error)}`, 'error');
      }
    },
  });

  pi.registerCommand('wechat-start', {
    description: '启动微信消息桥接',
    handler: async (_args, ctx) => {
      const activeClient = ensureClient();
      if (!activeClient) {
        notify('未找到微信凭证，请先执行 /wechat-login', 'error');
        return;
      }

      if (isRunning()) {
        notify('微信桥接已经在运行', 'info');
        return;
      }

      pollAbortController = new AbortController();
      notify('微信桥接已启动', 'info');
      drainQueue(ctx);

      void pollMessages(activeClient).finally(() => {
        if (pollAbortController?.signal.aborted) {
          pollAbortController = null;
        }
      });
    },
  });

  pi.registerCommand('wechat-stop', {
    description: '停止微信消息桥接',
    handler: async (_args, ctx) => {
      await stopBridge();
      notify('微信桥接已停止', 'info');
    },
  });

  pi.registerCommand('wechat-logout', {
    description: '清除微信凭证并停止桥接',
    handler: async (_args, ctx) => {
      await stopBridge({ clearClient: true });
      clearCredentials();
      notify(`已清除微信凭证: ${getCredentialsPath()}`, 'info');
    },
  });

  pi.registerCommand('wechat-status', {
    description: '查看微信桥接状态',
    handler: async (_args, ctx) => {
      rememberContext(ctx);

      const activeClient = client ?? loadClientFromDisk();
      const lines = [
        `运行状态: ${isRunning() ? 'running' : 'stopped'}`,
        `凭证状态: ${activeClient ? 'ready' : 'missing'}`,
        `账号 ID: ${activeClient?.accountId ?? '-'}`,
        `用户 ID: ${activeClient?.userId ?? '-'}`,
        `排队消息: ${inboundQueue.length}`,
        `等待注入: ${pendingInjection ? pendingInjection.preview : '-'}`,
        `处理中: ${activeRequest ? activeRequest.preview : '-'}`,
        `凭证路径: ${getCredentialsPath()}`,
      ];

      notify(lines.join('\n'), 'info');
    },
  });

  pi.on('session_start', async (_event, ctx) => {
    rememberContext(ctx);
    client ??= loadClientFromDisk();
  });

  pi.on('before_agent_start', async (event, ctx) => {
    rememberContext(ctx);

    const request = pendingInjection ?? activeRequest;
    if (!request) {
      return;
    }

    agentBarrier ??= new Promise((resolve) => {
      agentBarrierOpen = resolve;
    });

    return {
      systemPrompt: resolveBuildSystemPrompt(event.systemPrompt, request),
    };
  });

  pi.on('agent_start', async (_event, ctx) => {
    rememberContext(ctx);

    if (pendingInjection) {
      activeRequest = pendingInjection;
      pendingInjection = null;
    }
  });

  pi.on('agent_end', async (event, ctx) => {
    rememberContext(ctx);
    await completeActiveRequest(event.messages);
  });

  pi.on('session_shutdown', async (_event, ctx) => {
    rememberContext(ctx);
    await stopBridge();
  });

  pi.on('model_select', async (event, ctx) => {
    rememberContext(ctx);

    const prev = event.previousModel
      ? `${event.previousModel.provider}/${event.previousModel.id}`
      : 'none';
    const next = `${event.model.provider}/${event.model.id}`;

    const message = `模型已更改 (${event.source}): ${prev} -> ${next}`;
    const userId = activeRequest?.userId ?? pendingInjection?.userId;
    if (userId) {
      await sendReply(userId, message);
    } else {
      notify(message, 'info');
    }
  });
}

async function renderQrCode(url: string): Promise<string> {
  return new Promise((resolve) => {
    qrcode.generate(url, { small: true }, (code) => resolve(code));
  });
}

function extractFinalAssistantText(messages: AgentMessage[]) {
  return messages
    .findLast((message): message is AssistantMessage => {
      return message?.role === 'assistant';
    })
    ?.content.filter((part) => {
      return part.type === 'text';
    })
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function summarizePreview(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= PREVIEW_LIMIT) {
    return normalized;
  }

  return `${normalized.slice(0, PREVIEW_LIMIT - 1)}…`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
