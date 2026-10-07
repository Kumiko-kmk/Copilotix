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
import { DEFAULT_SETTINGS } from '@shared/constants'
import type { TaskRepositoryCompat } from './taskRepositoryCompat'

/** The only persistence SettingsService needs. */
export type SettingsRepositoryPort = Pick<TaskRepositoryCompat, 'getSettings' | 'saveSettings' | 'getMigrationMarker' | 'markMigration'>
import type { CredentialAccount, CredentialVault } from './credentialVault'

export const TRANSLATION_CREDENTIAL_RESET_MIGRATION = 'translation-credentials-preserved-v2'

export interface CredentialProbe {
  parser(value: string): Promise<HealthResult>
  provider(name: 'qwen' | 'deepseek', value: string, settings: AppSettings): Promise<HealthResult>
}

interface CachedValidation {
  fingerprint: string
  configFingerprint: string
  state: Extract<CredentialValidation, 'valid' | 'invalid'>
  errorCode?: string
  message?: string
}

const ACCOUNT_BY_NAME: Record<CredentialName, CredentialAccount> = {
  parser: 'parser-token',
  qwen: 'qwen-api-key',
  deepseek: 'deepseek-api-key'
}

const VALIDATION_ACCOUNT_BY_NAME: Record<CredentialName, CredentialAccount> = {
  parser: 'parser-token-validation',
  qwen: 'qwen-api-key-validation',
  deepseek: 'deepseek-api-key-validation'
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
    private readonly repository: SettingsRepositoryPort,
    private readonly vault: CredentialVault,
    private readonly defaultOutputRoot: string,
    probe: Partial<CredentialProbe> = {}
  ) {
    this.probe = { ...DEFAULT_PROBE, ...probe }
  }

  /** Record the one-time, non-destructive credential migration after the utility database is ready. */
  async initialize(): Promise<void> {
    try {
      if (await this.repository.getMigrationMarker(TRANSLATION_CREDENTIAL_RESET_MIGRATION)) return
      await this.repository.markMigration(TRANSLATION_CREDENTIAL_RESET_MIGRATION)
    } catch {
      // A marker-store failure must not prevent startup. No credential values
      // are changed, and the missing marker makes the next startup retry.
    }
  }

  async get(): Promise<AppSettings> {
    const settings = internalProviderSettings(await this.repository.getSettings(this.defaultOutputRoot))
    const [parserValue, qwenValue, deepseekValue] = await Promise.all([
      this.vault.get('parser-token'),
      this.vault.get('qwen-api-key'),
      this.vault.get('deepseek-api-key')
    ])
    await Promise.all([
      this.restoreValidation('parser', parserValue, settings),
      this.restoreValidation('qwen', qwenValue, settings),
      this.restoreValidation('deepseek', deepseekValue, settings)
    ])
    return {
      ...settings,
      credentials: {
        parser: this.statusFor('parser', parserValue, settings),
        qwen: this.statusFor('qwen', qwenValue, settings),
        deepseek: this.statusFor('deepseek', deepseekValue, settings)
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

    const settings = internalProviderSettings(settingsOverride ?? await this.repository.getSettings(this.defaultOutputRoot))
    try {
      const result = name === 'parser'
        ? await this.probe.parser(normalized)
        : await this.probe.provider(name, normalized, settings)
      const validation = validationFromHealth(result)
      if (validatingStored && validation.state === 'valid') {
        const cached = {
          fingerprint: fingerprint(normalized),
          configFingerprint: configFingerprint(name, settings),
          state: 'valid',
          message: validation.message
        } satisfies CachedValidation
        this.validations.set(name, cached)
        await this.persistValidation(name, cached)
      } else if (validatingStored && validation.state === 'invalid') {
        const cached = {
          fingerprint: fingerprint(normalized),
          configFingerprint: configFingerprint(name, settings),
          state: 'invalid',
          errorCode: validation.errorCode,
          message: validation.message
        } satisfies CachedValidation
        this.validations.set(name, cached)
        await this.persistValidation(name, cached)
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
      configFingerprint: configFingerprint(name, internalProviderSettings(await this.repository.getSettings(this.defaultOutputRoot))),
      state: 'invalid',
      errorCode,
      message
    })
    await this.persistValidation(name, this.validations.get(name)!)
  }

  private async saveInternal(update: SettingsUpdate): Promise<SettingsSaveResult> {
    const current = internalProviderSettings(await this.repository.getSettings(this.defaultOutputRoot))
    const { credentialMutations: _credentialMutations, ...publicUpdate } = update
    const enabledTranslationProviders = publicUpdate.translationProviderOrder
      .filter((provider) => publicUpdate.enabledTranslationProviders.includes(provider))
    const candidateSettings = {
      ...current,
      ...publicUpdate,
      chatConsentProvider: enabledTranslationProviders[0] !== current.translationProvider ? null : publicUpdate.chatConsentProvider,
      chatConsentVersion: enabledTranslationProviders[0] !== current.translationProvider ? null : publicUpdate.chatConsentVersion,
      qwenBaseUrl: DEFAULT_SETTINGS.qwenBaseUrl,
      qwenModel: DEFAULT_SETTINGS.qwenModel,
      deepseekBaseUrl: DEFAULT_SETTINGS.deepseekBaseUrl,
      deepseekModel: DEFAULT_SETTINGS.deepseekModel,
      formulaEnabled: true,
      tableEnabled: true,
      enabledTranslationProviders,
      translationProvider: enabledTranslationProviders[0]!
    }
    // A provider's validation is tied to its endpoint. Changing the endpoint
    // or model must return that credential to the pending state until it has
    // been checked against the new configuration.
    if (candidateSettings.qwenBaseUrl !== current.qwenBaseUrl || candidateSettings.qwenModel !== current.qwenModel) {
      this.validations.delete('qwen')
      await this.vault.delete(VALIDATION_ACCOUNT_BY_NAME.qwen)
    }
    if (candidateSettings.deepseekBaseUrl !== current.deepseekBaseUrl || candidateSettings.deepseekModel !== current.deepseekModel) {
      this.validations.delete('deepseek')
      await this.vault.delete(VALIDATION_ACCOUNT_BY_NAME.deepseek)
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
          await this.vault.delete(VALIDATION_ACCOUNT_BY_NAME[entry.name])
          this.validations.delete(entry.name)
        } else {
          await this.vault.set(account, entry.value!)
          const validation = {
            fingerprint: fingerprint(entry.value!),
            configFingerprint: configFingerprint(entry.name, candidateSettings),
            state: 'valid' as const,
            message: '凭据验证成功'
          }
          this.validations.set(entry.name, validation)
          await this.persistValidation(entry.name, validation)
        }
      } catch {
        fieldErrors[entry.name] = {
          code: 'CREDENTIAL_STORAGE_FAILED',
          message: '凭据存储失败，原有凭据未改变，请稍后重试'
        }
      }
    }

    await this.repository.saveSettings(candidateSettings)
    return { settings: await this.get(), fieldErrors }
  }

  private statusFor(name: CredentialName, value: string | null, settings: AppSettings): CredentialStatus {
    if (!value) return { state: 'missing' }
    const maskedValue = maskCredential(value)
    const cached = this.validations.get(name)
    if (!cached || cached.fingerprint !== fingerprint(value) || cached.configFingerprint !== configFingerprint(name, settings)) return { state: 'unknown', maskedValue }
    return {
      state: cached.state,
      maskedValue,
      ...(cached.errorCode ? { errorCode: cached.errorCode } : {}),
      ...(cached.message ? { message: cached.message } : {})
    }
  }

  private async persistValidation(name: CredentialName, validation: CachedValidation): Promise<void> {
    await this.vault.set(VALIDATION_ACCOUNT_BY_NAME[name], JSON.stringify({ version: 1, ...validation }))
  }

  private async restoreValidation(name: CredentialName, value: string | null, settings: AppSettings): Promise<void> {
    if (!value) {
      this.validations.delete(name)
      return
    }
    const raw = await this.vault.get(VALIDATION_ACCOUNT_BY_NAME[name])
    if (!raw) return
    try {
      const parsed = JSON.parse(raw) as Partial<CachedValidation> & { version?: unknown }
      if (parsed.version !== 1 || parsed.fingerprint !== fingerprint(value) ||
        parsed.configFingerprint !== configFingerprint(name, settings) ||
        (parsed.state !== 'valid' && parsed.state !== 'invalid')) return
      this.validations.set(name, {
        fingerprint: parsed.fingerprint,
        configFingerprint: parsed.configFingerprint,
        state: parsed.state,
        ...(typeof parsed.errorCode === 'string' ? { errorCode: parsed.errorCode } : {}),
        ...(typeof parsed.message === 'string' ? { message: parsed.message } : {})
      })
    } catch {
      this.validations.delete(name)
    }
  }
}

function configFingerprint(name: CredentialName, settings: AppSettings): string {
  if (name === 'qwen') return fingerprint(`${settings.qwenBaseUrl}\n${settings.qwenModel}`)
  if (name === 'deepseek') return fingerprint(`${settings.deepseekBaseUrl}\n${settings.deepseekModel}`)
  return fingerprint('mineru-parser-v1')
}

export function maskCredential(value: string): string {
  const normalized = value.trim()
  if (normalized.length <= 4) return '****'
  if (normalized.length <= 10) return `${normalized.slice(0, 2)}****${normalized.slice(-2)}`
  return `${normalized.slice(0, 5)}****${normalized.slice(-5)}`
}

function internalProviderSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    qwenBaseUrl: DEFAULT_SETTINGS.qwenBaseUrl,
    qwenModel: DEFAULT_SETTINGS.qwenModel,
    deepseekBaseUrl: DEFAULT_SETTINGS.deepseekBaseUrl,
    deepseekModel: DEFAULT_SETTINGS.deepseekModel
  }
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
  const unavailable = code === 'VALIDATION_UNAVAILABLE' || code === 'NETWORK_UNAVAILABLE' || code === 'PROXY_AUTH_REQUIRED' || /^HTTP_(?:408|429|5\d{2})$/u.test(code) || /(?:timeout|network|socket|econn|temporar|不可达|超时|代理)/iu.test(result.message)
  if (unavailable) return { state: 'unknown', errorCode: 'CREDENTIAL_VALIDATION_UNAVAILABLE', message: result.message || '暂时无法验证服务，请检查网络后重试' }
  if (code === 'PROVIDER_CONFIGURATION_INVALID') {
    return { state: 'invalid', errorCode: code, message: result.message || '服务地址或模型配置不可用' }
  }
  const invalidCode = code === 'A0202' ? 'PARSER_TOKEN_INVALID' : code === 'A0211' ? 'PARSER_TOKEN_EXPIRED' : 'CREDENTIAL_INVALID'
  return { state: 'invalid', errorCode: invalidCode, message: result.message || '凭据验证失败' }
}
