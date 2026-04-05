import {
  ApiError,
  buildTextMessage,
  getConfig,
  getUpdates,
  sendMessage,
  sendTyping,
} from './api.js';
import { getMaxTextChunk } from './config.js';
import {
  MessageItemType,
  MessageType,
  type Credentials,
  type IncomingMessage,
  type IncomingMessageType,
  type MessageItem,
  type WeixinMessage,
} from './types.js';

export class SessionExpiredError extends Error {
  constructor() {
    super('SESSION_EXPIRED');
    this.name = 'SessionExpiredError';
  }
}

function isSessionExpired(error: unknown): boolean {
  return error instanceof ApiError && error.code === -14;
}

export class WeixinClient {
  private readonly token: string;
  private readonly typingTickets = new Map<string, string>();
  private readonly contextTokens = new Map<string, string>();
  private baseUrl: string;
  private cursor = '';

  constructor(private readonly credentials: Credentials) {
    this.baseUrl = credentials.baseUrl;
    this.token = credentials.token;
  }

  get accountId(): string {
    return this.credentials.accountId;
  }

  get userId(): string {
    return this.credentials.userId;
  }

  async getUpdates(signal?: AbortSignal): Promise<IncomingMessage[]> {
    let response;
    try {
      response = await getUpdates(
        this.baseUrl,
        this.token,
        this.cursor,
        signal,
      );
    } catch (error) {
      if (isSessionExpired(error)) {
        throw new SessionExpiredError();
      }
      throw error;
    }

    this.cursor = response.get_updates_buf || this.cursor;
    const incoming: IncomingMessage[] = [];

    for (const raw of response.msgs ?? []) {
      this.rememberContext(raw);
      const normalized = this.normalizeIncomingMessage(raw);
      if (normalized) {
        incoming.push(normalized);
      }
    }

    return incoming;
  }

  async sendText(userId: string, text: string): Promise<void> {
    const contextToken = this.contextTokens.get(userId);
    if (!contextToken) {
      throw new Error(`No cached context token for user ${userId}`);
    }

    const message = text.trim();
    if (!message) {
      throw new Error('Message text cannot be empty');
    }

    const maxChunkSize = getMaxTextChunk();
    for (const chunk of chunkText(message, maxChunkSize)) {
      await sendMessage(
        this.baseUrl,
        this.token,
        buildTextMessage(userId, contextToken, chunk),
      );
    }
  }

  async sendTyping(userId: string): Promise<void> {
    const ticket = await this.getTypingTicket(userId);
    if (!ticket) return;
    await sendTyping(this.baseUrl, this.token, userId, ticket, 1);
  }

  async stopTyping(userId: string): Promise<void> {
    const ticket = await this.getTypingTicket(userId);
    if (!ticket) return;
    await sendTyping(this.baseUrl, this.token, userId, ticket, 2);
  }

  rememberContext(message: WeixinMessage): void {
    const userId =
      message.message_type === MessageType.USER
        ? message.from_user_id
        : message.to_user_id;
    if (userId && message.context_token) {
      this.contextTokens.set(userId, message.context_token);
    }
  }

  private normalizeIncomingMessage(
    message: WeixinMessage,
  ): IncomingMessage | null {
    if (message.message_type !== MessageType.USER) {
      return null;
    }

    const type = detectType(message.item_list);
    return {
      messageId: String(message.message_id),
      userId: message.from_user_id,
      text: extractText(message.item_list, type),
      type,
      raw: message,
      contextToken: message.context_token,
      timestamp: new Date(message.create_time_ms),
    };
  }

  private async getTypingTicket(userId: string): Promise<string | null> {
    const cached = this.typingTickets.get(userId);
    if (cached) {
      return cached;
    }

    const contextToken = this.contextTokens.get(userId);
    if (!contextToken) {
      return null;
    }

    const config = await getConfig(
      this.baseUrl,
      this.token,
      userId,
      contextToken,
    );
    if (!config.typing_ticket) {
      return null;
    }

    this.typingTickets.set(userId, config.typing_ticket);
    return config.typing_ticket;
  }
}

function detectType(items: MessageItem[]): IncomingMessageType {
  for (const item of items) {
    switch (item.type) {
      case MessageItemType.TEXT:
        return 'text';
      case MessageItemType.IMAGE:
        return 'image';
      case MessageItemType.VOICE:
        return 'voice';
      case MessageItemType.FILE:
        return 'file';
      case MessageItemType.VIDEO:
        return 'video';
    }
  }

  return 'text';
}

function extractText(items: MessageItem[], type: IncomingMessageType): string {
  const text = items
    .filter(
      (item) => item.type === MessageItemType.TEXT && item.text_item?.text,
    )
    .map((item) => item.text_item?.text?.trim())
    .filter(Boolean)
    .join('\n');

  if (text) {
    return text;
  }

  switch (type) {
    case 'image':
      return '[用户发送了一张图片，当前扩展尚未下载图片内容。]';
    case 'voice':
      return (
        items
          .find((item) => item.type === MessageItemType.VOICE)
          ?.voice_item?.text?.trim() ||
        '[用户发送了一条语音，当前扩展尚未转写完整音频。]'
      );
    case 'file':
      return `[用户发送了文件：${items.find((item) => item.type === MessageItemType.FILE)?.file_item?.file_name || '未命名文件'}]`;
    case 'video':
      return '[用户发送了一段视频，当前扩展尚未提取视频内容。]';
    default:
      return '[收到一条空文本消息]';
  }
}

function chunkText(text: string, maxLength: number): string[] {
  const count = Math.ceil(text.length / maxLength);
  return Array.from({ length: count }, (_, i) =>
    text.slice(i * maxLength, (i + 1) * maxLength).trim(),
  ).filter(Boolean);
}
