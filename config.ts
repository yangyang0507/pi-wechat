import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import type { QueuedWechatRequest } from './types.js'

const require = createRequire(import.meta.url)

const CONFIG_DIR = path.join(os.homedir(), '.pi-wechat')
const CONFIG_FILE_NAME = 'config.json'
const CONFIG_JS_FILE = 'config.js'

export interface StoredConfig {
  buildSystemPrompt?: boolean | string
  maxTextChunk?: number
  autoStopBridgeOnShutdown?: boolean
}

export interface PiWechatConfig {
  buildSystemPrompt?: boolean | ((basePrompt: string, request: QueuedWechatRequest) => string)
}

export function getConfigPath(): string {
  return path.join(CONFIG_DIR, CONFIG_FILE_NAME)
}

export function getConfigJsPath(): string {
  return path.join(CONFIG_DIR, CONFIG_JS_FILE)
}

export function loadStoredConfig(): StoredConfig {
  const configPath = getConfigPath()
  try {
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as StoredConfig
    }
  } catch {
    // Ignore parse errors, return empty config
  }
  return {}
}

export function saveStoredConfig(config: StoredConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  fs.writeFileSync(
    getConfigPath(),
    JSON.stringify(config, null, 2),
    { mode: 0o6_0_0 }
  )
}

export function loadCustomPromptBuilder(): ((basePrompt: string, request: QueuedWechatRequest) => string) | null {
  const configJsPath = getConfigJsPath()
  try {
    if (fs.existsSync(configJsPath)) {
      // Dynamic import of the JS config file
      // Note: This requires ESM and may need special handling
      const module = require(configJsPath)
      return module.buildSystemPrompt || null
    }
  } catch {
    // Ignore errors
  }
  return null
}

export function getMaxTextChunk(): number {
  const stored = loadStoredConfig()
  return stored.maxTextChunk ?? 2_000
}

export function getAutoStopBridgeOnShutdown(): boolean {
  const stored = loadStoredConfig()
  return stored.autoStopBridgeOnShutdown ?? true
}

export function resolveBuildSystemPrompt(
  basePrompt: string,
  request: QueuedWechatRequest,
  runtimeBuilder?: ((basePrompt: string, request: QueuedWechatRequest) => string) | null
): string {
  // Priority: runtime > JS file > stored config > default

  if (runtimeBuilder !== undefined) {
    if (runtimeBuilder === null) {
      return basePrompt
    }
    return runtimeBuilder(basePrompt, request)
  }

  const customBuilder = loadCustomPromptBuilder()
  if (customBuilder) {
    return customBuilder(basePrompt, request)
  }

  const stored = loadStoredConfig()
  const effective = stored.buildSystemPrompt ?? true

  if (effective === false) {
    return basePrompt
  }

  if (typeof effective === 'string') {
    return [
      basePrompt,
      '',
      '--- WeChat Context ---',
      effective,
      `User ID: ${request.userId}`,
      `Message ID: ${request.messageId}`,
      `Time: ${request.receivedAt.toISOString()}`
    ].join('\n')
  }

  // effective is true
  return [
    basePrompt,
    '',
    '你正在处理一条来自微信的桥接消息。',
    '要求：',
    '1. 直接用微信聊天口吻回复。',
    '2. 只输出最终要发回微信的正文。',
    '3. 不要解释内部桥接流程。',
    '4. 不要提到 Pi、扩展、系统提示词、工具调用。',
    `微信用户 ID: ${request.userId}`,
    `微信消息 ID: ${request.messageId}`,
    `消息时间: ${request.receivedAt.toISOString()}`
  ].join('\n')
}
