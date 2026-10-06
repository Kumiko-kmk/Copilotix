import { Entry } from '@napi-rs/keyring'
import { createHash } from 'node:crypto'
import { CREDENTIAL_SERVICE } from '@shared/constants'

/** Test workspaces must never read or overwrite the user's native credentials. */
export function credentialServiceForRuntime(options: {
  isPackaged: boolean
  nodeEnv?: string
  e2eUserData?: string
}): string {
  if (options.isPackaged || options.nodeEnv !== 'test' || !options.e2eUserData) return CREDENTIAL_SERVICE
  return `${CREDENTIAL_SERVICE}-e2e-${createHash('sha256').update(options.e2eUserData).digest('hex')}`
}

export type CredentialAccount =
  | 'parser-token'
  | 'qwen-api-key'
  | 'deepseek-api-key'
  | 'parser-token-validation'
  | 'qwen-api-key-validation'
  | 'deepseek-api-key-validation'

export interface CredentialVault {
  get(account: CredentialAccount): Promise<string | null>
  set(account: CredentialAccount, value: string): Promise<void>
  delete(account: CredentialAccount): Promise<void>
  has(account: CredentialAccount): Promise<boolean>
}

export class WindowsCredentialVault implements CredentialVault {
  constructor(private readonly service = CREDENTIAL_SERVICE) {}

  async get(account: CredentialAccount): Promise<string | null> {
    try {
      return new Entry(this.service, account).getPassword()
    } catch {
      return null
    }
  }

  async set(account: CredentialAccount, value: string): Promise<void> {
    const normalized = value.trim()
    if (!normalized) {
      await this.delete(account)
      return
    }
    new Entry(this.service, account).setPassword(normalized)
  }

  async delete(account: CredentialAccount): Promise<void> {
    try {
      new Entry(this.service, account).deletePassword()
    } catch (error) {
      // The native binding reports a missing item as NoEntry. That case is
      // intentionally idempotent; other failures (for example an unavailable
      // Windows credential manager) must reach SettingsService so a migration
      // or per-field save is not falsely reported as complete.
      const message = error instanceof Error ? error.message : String(error)
      const code = error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code ?? '')
        : ''
      if (code === 'ENOENT' || code === 'NotFound' || code === 'NO_ENTRY' || /(?:no.?entry|not found|no such credential|does not exist)/iu.test(message)) return
      throw error
    }
  }

  async has(account: CredentialAccount): Promise<boolean> {
    return (await this.get(account)) !== null
  }
}
