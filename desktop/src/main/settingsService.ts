import { createHash } from 'node:crypto'
import type {
  AppSettings,
  CredentialFieldError,
  CredentialMutation,
  CredentialName,
  CredentialStatus,
  CredentialValidation,
  CredentialValidationResult,
  HealthResult,
  SettingsSaveResult,
  SettingsUpdate
} from '@shared/types'
import type { TaskRepositoryCompat } from './taskRepositoryCompat'
import type { CredentialAccount, CredentialVault } from './credentialVault'

export const TRANSLATION_CREDENTIAL_RESET_MIGRATION = 'translation-credentials-reset-v1'

export interface CredentialProbe {
  parser(value: string): Promise<HealthResult>
  provider(name: 'qwen' | 'deepseek', value: string, settings: AppSettings): Promise<HealthResult>
}

interface CachedValidation {
  fingerprint: string
  state: Extract<CredentialValidation, 'valid' | 'invalid'>
  errorCode?: string
  message?: string
}

const ACCOUNT_BY_NAME: Record<CredentialName, CredentialAccount> = {
  parser: 'parser-token',
  qwen: 'qwen-api-key',
  deepseek: 'deepseek-api-key'
}

const DEFAULT_PROBE: CredentialProbe = {
  parser: async () => ({ ok: false, code: 'VALIDATION_UNAVAILABLE', message: '凭据验证服务尚未初始化' }),
  provider: async () => ({ ok: false, code: 'VALIDATION_UNAVAILABLE', message: '凭据验证服务尚未初始化' })
}

export class SettingsService {
  private readonly probe: CredentialProbe
  private readonly validations = new Map<CredentialName, CachedValidation>()
  private saveTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly repository: TaskRepositoryCompat,
    private readonly vault: CredentialVault,
    private readonly defaultOutputRoot: string,
    probe: Partial<CredentialProbe> = {}
  ) {
    this.probe = { ...DEFAULT_PROBE, ...probe }
  }

  /** Run the one-time upgrade cleanup after the utility database is ready. */
  async initialize(): Promise<void> {
    if (!this.repository.getMigrationMarker || !this.repository.markMigration) return
    if (await this.repository.getMigrationMarker(TRANSLATION_CREDENTIAL_RESET_MIGRATION)) return

    // The operation is deliberately idempotent. Do not mark the migration if
    // either credential deletion fails; the next startup will retry safely.
    try {
      await Promise.all([
        this.vault.delete('qwen-api-key'),
        this.vault.delete('deepseek-api-key')
      ])
      this.validations.delete('qwen')
      this.validations.delete('deepseek')
      await this.repository.markMigration(TRANSLATION_CREDENTIAL_RESET_MIGRATION)
    } catch {
      // A transient credential-store failure must not prevent the application
      // from starting. Leaving the marker absent makes the next startup retry
      // the idempotent cleanup.
    }
  }

  async get(): Promise<AppSettings> {
    const settings = await this.repository.getSettings(this.defaultOutputRoot)
    const values = await Promise.all([
      this.vault.get('parser-token'),
      this.vault.get('qwen-api-key'),
      this.vault.get('deepseek-api-key')
    ])
    return {
      ...settings,
      credentials: {
        parser: this.statusFor('parser', values[0]),
        qwen: this.statusFor('qwen', values[1]),
        deepseek: this.statusFor('deepseek', values[2])
      }
    }
  }

  async validateCredential(name: CredentialName, value?: string, settingsOverride?: AppSettings): Promise<CredentialValidationResult> {
    const validatingStored = value === undefined
    const candidate = validatingStored ? await this.vault.get(ACCOUNT_BY_NAME[name]) : value
    const normalized = candidate ? normalizeCredential(candidate) : null
    if (!normalized) {
      return validatingStored
        ? { state: 'missing', message: '尚未配置凭据' }
        : { state: 'invalid', errorCode: 'CREDENTIAL_FORMAT_INVALID', message: '凭据不能为空或包含控制字符' }
    }

    const settings = settingsOverride ?? await this.repository.getSettings(this.defaultOutputRoot)
    try {
      const result = name === 'parser'
        ? await this.probe.parser(normalized)
        : await this.probe.provider(name, normalized, settings)
      const validation = validationFromHealth(result)
      if (validatingStored && validation.state === 'valid') {
        this.validations.set(name, {
          fingerprint: fingerprint(normalized),
          state: 'valid',
          message: validation.message
        })
      } else if (validatingStored && validation.state === 'invalid') {
        this.validations.set(name, {
          fingerprint: fingerprint(normalized),
          state: 'invalid',
          errorCode: validation.errorCode,
          message: validation.message
        })
      }
      return validation
    } catch {
      return { state: 'unknown', errorCode: 'CREDENTIAL_VALIDATION_UNAVAILABLE', message: '暂时无法验证服务，请检查网络后重试' }
    }
  }

  /**
   * Validate and commit credentials independently. Public settings are saved
   * even when one or more candidate credentials are rejected.
   */
  async save(update: SettingsUpdate): Promise<SettingsSaveResult> {
    const run = this.saveTail.then(() => this.saveInternal(update), () => this.saveInternal(update))
    this.saveTail = run.then(() => undefined, () => undefined)
    return run
  }

  /** Mark a stored credential invalid after a runtime 401/403 response. */
  async invalidateCredential(name: CredentialName, errorCode = 'CREDENTIAL_INVALID', message = '凭据已失效，请重新验证'): Promise<void> {
    const value = await this.vault.get(ACCOUNT_BY_NAME[name])
    if (!value) {
      this.validations.delete(name)
      return
    }
    this.validations.set(name, {
      fingerprint: fingerprint(value),
      state: 'invalid',
      errorCode,
      message
    })
  }

  private async saveInternal(update: SettingsUpdate): Promise<SettingsSaveResult> {
    const current = await this.repository.getSettings(this.defaultOutputRoot)
    const { credentialMutations: _credentialMutations, ...publicUpdate } = update
    const candidateSettings = { ...current, ...publicUpdate }
    // A provider's validation is tied to its endpoint. Changing the endpoint
    // or model must return that credential to the pending state until it has
    // been checked against the new configuration.
    if (publicUpdate.qwenBaseUrl !== current.qwenBaseUrl || publicUpdate.qwenModel !== current.qwenModel) {
      this.validations.delete('qwen')
    }
    if (publicUpdate.deepseekBaseUrl !== current.deepseekBaseUrl || publicUpdate.deepseekModel !== current.deepseekModel) {
      this.validations.delete('deepseek')
    }
    const fieldErrors: Partial<Record<CredentialName, CredentialFieldError>> = {}
    const committed: Array<{ name: CredentialName; mutation: CredentialMutation; value?: string }> = []

    for (const name of ['parser', 'qwen', 'deepseek'] as const) {
      const mutation = update.credentialMutations?.[name]
      if (!mutation) continue
      if (mutation.action === 'clear') {
        committed.push({ name, mutation })
        continue
      }

      const normalized = normalizeCredential(mutation.value)
      if (!normalized) {
        fieldErrors[name] = { code: 'CREDENTIAL_FORMAT_INVALID', message: '凭据不能为空或包含控制字符' }
        continue
      }
      const result = await this.validateCredential(name, normalized, candidateSettings)
      if (result.state !== 'valid') {
        fieldErrors[name] = {
          code: result.errorCode ?? (result.state === 'unknown' ? 'CREDENTIAL_VALIDATION_UNAVAILABLE' : 'CREDENTIAL_INVALID'),
          message: result.message ?? (result.state === 'unknown' ? '暂时无法验证服务，请检查网络后重试' : '凭据验证失败')
        }
        continue
      }
      committed.push({ name, mutation, value: normalized })
    }

    for (const entry of committed) {
      const account = ACCOUNT_BY_NAME[entry.name]
      try {
        if (entry.mutation.action === 'clear') {
          await this.vault.delete(account)
          this.validations.delete(entry.name)
        } else {
          await this.vault.set(account, entry.value!)
          this.validations.set(entry.name, { fingerprint: fingerprint(entry.value!), state: 'valid', message: '凭据验证成功' })
        }
      } catch {
        fieldErrors[entry.name] = {
          code: 'CREDENTIAL_STORAGE_FAILED',
          message: '凭据存储失败，原有凭据未改变，请稍后重试'
        }
      }
    }

    await this.repository.saveSettings({ ...current, ...publicUpdate })
    return { settings: await this.get(), fieldErrors }
  }

  private statusFor(name: CredentialName, value: string | null): CredentialStatus {
    if (!value) return { state: 'missing' }
    const maskedValue = maskCredential(value)
    const cached = this.validations.get(name)
    if (!cached || cached.fingerprint !== fingerprint(value)) return { state: 'unknown', maskedValue }
    return {
      state: cached.state,
      maskedValue,
      ...(cached.errorCode ? { errorCode: cached.errorCode } : {}),
      ...(cached.message ? { message: cached.message } : {})
    }
  }
}

export function maskCredential(value: string): string {
  const normalized = value.trim()
  if (normalized.length <= 4) return '****'
  if (normalized.length <= 8) return `${normalized.slice(0, 2)}****${normalized.slice(-2)}`
  return `${normalized.slice(0, 4)}****${normalized.slice(-4)}`
}

function normalizeCredential(value: string): string | null {
  const normalized = value.trim()
  if (!normalized || normalized.length > 16_384 || hasControlCharacters(normalized)) return null
  return normalized
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true
  }
  return false
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function validationFromHealth(result: HealthResult): CredentialValidationResult {
  if (result.ok) return { state: 'valid', message: '凭据验证成功' }
  const code = typeof result.code === 'string' ? result.code : String(result.code ?? '')
  const unavailable = code === 'VALIDATION_UNAVAILABLE' || code === 'NETWORK_UNAVAILABLE' || /^HTTP_(?:408|429|5\d{2})$/u.test(code) || /(?:timeout|network|socket|econn|temporar|不可达|超时)/iu.test(result.message)
  if (unavailable) return { state: 'unknown', errorCode: 'CREDENTIAL_VALIDATION_UNAVAILABLE', message: '暂时无法验证服务，请检查网络后重试' }
  const invalidCode = code === 'A0202' ? 'PARSER_TOKEN_INVALID' : code === 'A0211' ? 'PARSER_TOKEN_EXPIRED' : 'CREDENTIAL_INVALID'
  return { state: 'invalid', errorCode: invalidCode, message: '凭据验证失败' }
}
