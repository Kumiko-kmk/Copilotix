import type { AppSettings, SettingsUpdate } from '@shared/types'
import type { TaskRepository } from './database'
import type { CredentialVault } from './credentialVault'

export class SettingsService {
  constructor(
    private readonly repository: TaskRepository,
    private readonly vault: CredentialVault,
    private readonly defaultOutputRoot: string
  ) {}

  async get(): Promise<AppSettings> {
    const settings = this.repository.getSettings(this.defaultOutputRoot)
    const [hasParserToken, qwenHasApiKey, deepseekHasApiKey] = await Promise.all([
      this.vault.has('parser-token'),
      this.vault.has('qwen-api-key'),
      this.vault.has('deepseek-api-key')
    ])
    return { ...settings, hasParserToken, qwenHasApiKey, deepseekHasApiKey }
  }

  async save(update: SettingsUpdate): Promise<AppSettings> {
    await Promise.all([
      this.updateCredential('parser-token', update.parserToken, update.clearParserToken),
      this.updateCredential('qwen-api-key', update.qwenApiKey, update.clearQwenApiKey),
      this.updateCredential('deepseek-api-key', update.deepseekApiKey, update.clearDeepseekApiKey)
    ])
    const current = await this.get()
    const {
      parserToken: _parserToken,
      clearParserToken: _clearParserToken,
      qwenApiKey: _qwenApiKey,
      clearQwenApiKey: _clearQwenApiKey,
      deepseekApiKey: _deepseekApiKey,
      clearDeepseekApiKey: _clearDeepseekApiKey,
      ...publicUpdate
    } = update
    this.repository.saveSettings({ ...current, ...publicUpdate })
    return this.get()
  }

  private async updateCredential(
    account: 'parser-token' | 'qwen-api-key' | 'deepseek-api-key',
    value?: string,
    clear?: boolean
  ): Promise<void> {
    if (clear) await this.vault.delete(account)
    else if (value?.trim()) await this.vault.set(account, value)
  }
}
