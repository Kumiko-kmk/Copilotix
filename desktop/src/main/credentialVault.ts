import { Entry } from '@napi-rs/keyring'
import { CREDENTIAL_SERVICE } from '@shared/constants'

export type CredentialAccount = 'parser-token' | 'qwen-api-key' | 'deepseek-api-key'

export interface CredentialVault {
  get(account: CredentialAccount): Promise<string | null>
  set(account: CredentialAccount, value: string): Promise<void>
  delete(account: CredentialAccount): Promise<void>
  has(account: CredentialAccount): Promise<boolean>
}

export class WindowsCredentialVault implements CredentialVault {
  async get(account: CredentialAccount): Promise<string | null> {
    try {
      return new Entry(CREDENTIAL_SERVICE, account).getPassword()
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
    new Entry(CREDENTIAL_SERVICE, account).setPassword(normalized)
  }

  async delete(account: CredentialAccount): Promise<void> {
    try {
      new Entry(CREDENTIAL_SERVICE, account).deletePassword()
    } catch {
      // Removing a missing credential is intentionally idempotent.
    }
  }

  async has(account: CredentialAccount): Promise<boolean> {
    return (await this.get(account)) !== null
  }
}
