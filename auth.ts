import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DEFAULT_BASE_URL, fetchQrCode, getQrCodeStatus } from './api.js'
import type { Credentials } from './types.js'

const CONFIG_DIR = path.join(os.homedir(), '.pi-wechat')
const CREDS_FILE = path.join(CONFIG_DIR, 'credentials.json')

export function getCredentialsPath(): string {
  return CREDS_FILE
}

export function loadCredentials(): Credentials | null {
  try {
    return JSON.parse(fs.readFileSync(CREDS_FILE, 'utf-8')) as Credentials
  } catch {
    return null
  }
}

export function saveCredentials(creds: Credentials): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  fs.writeFileSync(
    CREDS_FILE,
    JSON.stringify(
      {
        ...creds,
        savedAt: new Date().toISOString()
      },
      null,
      2
    ),
    { mode: 0o600 }
  )
}

export function clearCredentials(): void {
  try {
    fs.unlinkSync(CREDS_FILE)
  } catch {
    // Ignore missing credentials.
  }
}

export async function getQrCode(
  baseUrl: string = DEFAULT_BASE_URL
): Promise<{ url: string; token: string }> {
  const response = await fetchQrCode(baseUrl)
  return {
    url: response.qrcode_img_content,
    token: response.qrcode
  }
}

export async function pollQrStatus(
  token: string,
  baseUrl: string = DEFAULT_BASE_URL
): Promise<{
  status: 'wait' | 'scaned' | 'confirmed' | 'expired'
  credentials?: Credentials
}> {
  const response = await getQrCodeStatus(token, baseUrl)
  if (response.status !== 'confirmed') {
    return { status: response.status }
  }

  return {
    status: 'confirmed',
    credentials: {
      token: response.bot_token ?? '',
      baseUrl: response.baseurl || baseUrl,
      accountId: response.ilink_bot_id ?? '',
      userId: response.ilink_user_id ?? '',
      savedAt: new Date().toISOString()
    }
  }
}
