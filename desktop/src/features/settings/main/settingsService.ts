import { createHash } from 'node:crypto'
import { sharedModelRuntime, configureModelConnections, keyConnection } from '@platform/models/main/modelRuntime'
import { createConnection, type KeyProvider, type ProviderKey } from '@platform/models/contract/models'
import type {
  AppSettings,
  CredentialFieldError,
  CredentialMutation,
  CredentialName,
  CredentialStatus,
  CredentialValidation,
  CredentialValidationResult,
  KeyStatus,
  SettingsSaveResult,
  SettingsUpdate
} from '../contract/settingsTypes'
import type { HealthResult } from '@features/library/contract/documentTypes'
import { DEFAULT_SETTINGS } from '../contract/defaultSettings'
import { resolvePaperChatModel } from '@features/chat/contract/paperChatSchemas'
import type { TaskRepositoryCompat } from '@features/library/contract/taskRepository'
import { accountFor, credentialProvider, isKeyConnection, isKeyId, KEY_PROVIDERS, normalizeConnections, orderedKeys, providerSummary, runtimeHealth, validationAccountFor, type CredentialId } from './modelKeys'

/** The only persistence SettingsService needs. */
export type SettingsRepositoryPort = Pick<TaskRepositoryCompat, 'getSettings' | 'saveSettings' | 'getMigrationMarker' | 'markMigration'>
import type { CredentialVault } from '@platform/credentials/main/credentialVault'

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

const DEFAULT_PROBE: CredentialProbe = {
  parser: async () => ({ ok: false, code: 'VALIDATION_UNAVAILABLE', message: '凭据验证服务尚未初始化' }),
  provider: async () => ({ ok: false, code: 'VALIDATION_UNAVAILABLE', message: '凭据验证服务尚未初始化' })
}

export class SettingsService {
  private readonly probe: CredentialProbe
  private readonly validations = new Map<CredentialId, CachedValidation>()
  private saveTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly repository: SettingsRepositoryPort,
    private readonly vault: CredentialVault,
    private readonly defaultOutputRoot: string,
    probe: Partial<CredentialProbe> = {},
    private readonly now: () => number = Date.now
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
    const stored = normalizeConnections(settings.modelConnections)
    const keys = stored.filter(isKeyConnection)
    const [parserValue, ...keyValues] = await Promise.all([
      this.vault.get('parser-token'),
      ...keys.map(connection => this.vault.get(accountFor(connection.connectionId)))
    ])
    await Promise.all([
      this.restoreValidation('parser', parserValue ?? null, settings),
      ...keys.map((connection, index) => this.restoreValidation(connection.connectionId, keyValues[index] ?? null, settings))
    ])
    // A default key that was never filled in is only a placeholder from defaultConnections().
    const shown = stored.filter(connection => !isKeyConnection(connection) || !connection.connectionId.endsWith(':default') || Boolean(keyValues[keys.indexOf(connection)]))
    configureModelConnections(shown)
    const keyStatuses: Record<string, KeyStatus> = {}
    keys.forEach((connection, index) => {
      if (!shown.includes(connection)) return
      keyStatuses[connection.connectionId] = {
        ...this.statusFor(connection.connectionId, keyValues[index] ?? null, settings),
        ...runtimeHealth(sharedModelRuntime.health(connection.connectionId), this.now())
      }
    })
    return {
      ...settings,
      modelConnections: shown,
      keyStatuses,
      credentials: {
        parser: this.statusFor('parser', parserValue ?? null, settings),
        qwen: providerSummary(shown, keyStatuses, 'qwen'),
        deepseek: providerSummary(shown, keyStatuses, 'deepseek')
      }
    }
  }

  /** Verified, enabled keys of one provider in request order; the runtime moves to the next on cooldown or rejection. */
  async providerKeys(provider: KeyProvider): Promise<ProviderKey[]> {
    const settings = await this.get()
    const result: ProviderKey[] = []
    for (const connection of orderedKeys(settings.modelConnections ?? [], provider)) {
      if (settings.keyStatuses?.[connection.connectionId]?.state !== 'valid') continue
      const key = await this.vault.get(accountFor(connection.connectionId))
      if (key) result.push({ connection: keyConnection(connection, key), key })
    }
    return result
  }

  async validateCredential(name: CredentialName, value?: string, options: { settings?: AppSettings; connectionId?: string } = {}): Promise<CredentialValidationResult> {
    const id: CredentialId = name === 'parser' ? 'parser' : options.connectionId ?? `${name}:default`
    if (id !== 'parser' && (!isKeyId(id) || credentialProvider(id) !== name)) {
      return { state: 'invalid', errorCode: 'CREDENTIAL_FORMAT_INVALID', message: '密钥与服务商不匹配' }
    }
    const validatingStored = value === undefined
    const candidate = validatingStored ? await this.vault.get(accountFor(id)) : value
    const normalized = candidate ? normalizeCredential(candidate) : null
    if (!normalized) {
      return validatingStored
        ? { state: 'missing', message: '尚未配置凭据' }
        : { state: 'invalid', errorCode: 'CREDENTIAL_FORMAT_INVALID', message: '凭据不能为空或包含控制字符' }
    }

    const settings = internalProviderSettings(options.settings ?? await this.repository.getSettings(this.defaultOutputRoot))
    try {
      const result = name === 'parser'
        ? await this.probe.parser(normalized)
        : await this.probe.provider(name, normalized, settings)
      const validation = validationFromHealth(result)
      if (validatingStored && (validation.state === 'valid' || validation.state === 'invalid')) {
        if (id !== 'parser' && validation.state === 'valid') sharedModelRuntime.reset(id)
        const cached = {
          fingerprint: fingerprint(normalized),
          configFingerprint: configFingerprint(name, settings),
          state: validation.state,
          ...(validation.state === 'invalid' && validation.errorCode ? { errorCode: validation.errorCode } : {}),
          ...(validation.message ? { message: validation.message } : {})
        } satisfies CachedValidation
        this.validations.set(id, cached)
        await this.persistValidation(id, cached)
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

  /**
   * Mark a stored credential invalid after a runtime 401/403 response. For a
   * model provider this persists the keys the runtime has rejected; the others stay usable.
   */
  async invalidateCredential(name: CredentialName, errorCode = 'CREDENTIAL_INVALID', message = '凭据已失效，请重新验证'): Promise<void> {
    if (name === 'parser') return this.invalidateKey('parser', errorCode, message)
    const connections = normalizeConnections((await this.repository.getSettings(this.defaultOutputRoot)).modelConnections)
    for (const connection of connections) {
      if (connection.provider === name && sharedModelRuntime.health(connection.connectionId).status === 'invalid') {
        await this.invalidateKey(connection.connectionId, errorCode, message)
      }
    }
  }

  /** Persist one key's rejection (reported by the shared model runtime) without touching its siblings. */
  async invalidateKey(id: CredentialId, errorCode = 'CREDENTIAL_INVALID', message = '凭据已失效，请重新验证'): Promise<void> {
    if (id !== 'parser' && !isKeyId(id)) return
    const value = await this.vault.get(accountFor(id))
    if (!value) {
      this.validations.delete(id)
      return
    }
    this.validations.set(id, {
      fingerprint: fingerprint(value),
      configFingerprint: configFingerprint(credentialProvider(id), internalProviderSettings(await this.repository.getSettings(this.defaultOutputRoot))),
      state: 'invalid',
      errorCode,
      message
    })
    await this.persistValidation(id, this.validations.get(id)!)
  }

  private async saveInternal(update: SettingsUpdate): Promise<SettingsSaveResult> {
    const current = internalProviderSettings(await this.repository.getSettings(this.defaultOutputRoot))
    // keyStatuses is derived on read; the RPC envelope rejects even an undefined copy of it.
    const { credentialMutations: _credentialMutations, keyMutations: _keyMutations, keyStatuses: _keyStatuses, ...publicUpdate } = update as SettingsUpdate & { keyStatuses?: unknown }
    const enabledTranslationProviders = publicUpdate.translationProviderOrder
      .filter((provider) => publicUpdate.enabledTranslationProviders.includes(provider))
    const before = normalizeConnections(current.modelConnections)
    const requested = normalizeConnections(publicUpdate.modelConnections ?? before)
    // qwen/deepseek credential mutations address that provider's default key.
    const keyMutations: Record<string, CredentialMutation> = { ...update.keyMutations }
    for (const name of KEY_PROVIDERS) {
      const mutation = update.credentialMutations?.[name]
      if (!mutation) continue
      keyMutations[`${name}:default`] ??= mutation
      if (mutation.action === 'set' && !requested.some(value => value.connectionId === `${name}:default`)) {
        requested.unshift(createConnection(name, `${name}:default`, 0))
      }
    }
    const candidateSettings = {
      ...current,
      ...publicUpdate,
      chatConsentProvider: null,
      chatConsentVersion: null,
      qwenBaseUrl: DEFAULT_SETTINGS.qwenBaseUrl,
      qwenModel: DEFAULT_SETTINGS.qwenModel,
      deepseekBaseUrl: DEFAULT_SETTINGS.deepseekBaseUrl,
      deepseekModel: DEFAULT_SETTINGS.deepseekModel,
      formulaEnabled: true,
      tableEnabled: true,
      enabledTranslationProviders,
      translationProvider: enabledTranslationProviders[0] ?? null
    }
    const keyErrors: Record<string, CredentialFieldError> = {}
    const committed: Array<{ id: CredentialId; mutation: CredentialMutation; value?: string }> = []
    const parserMutation = update.credentialMutations?.parser
    const candidates: Array<[CredentialId, CredentialMutation]> = [
      ...(parserMutation ? [['parser', parserMutation] as [CredentialId, CredentialMutation]] : []),
      ...Object.entries(keyMutations).filter(([id]) => requested.some(value => value.connectionId === id && isKeyConnection(value)))
    ]

    for (const [id, mutation] of candidates) {
      if (mutation.action === 'clear') {
        committed.push({ id, mutation })
        continue
      }
      const name = credentialProvider(id)
      const normalized = normalizeCredential(mutation.value)
      const result: CredentialValidationResult = normalized
        ? await this.validateCredential(name, normalized, { settings: candidateSettings, ...(id === 'parser' ? {} : { connectionId: id }) })
        : { state: 'invalid', errorCode: 'CREDENTIAL_FORMAT_INVALID', message: '凭据不能为空或包含控制字符' }
      if (result.state !== 'valid' || !normalized) {
        keyErrors[id] = {
          code: result.errorCode ?? (result.state === 'unknown' ? 'CREDENTIAL_VALIDATION_UNAVAILABLE' : 'CREDENTIAL_INVALID'),
          message: result.message ?? (result.state === 'unknown' ? '暂时无法验证服务，请检查网络后重试' : '凭据验证失败')
        }
        continue
      }
      committed.push({ id, mutation, value: normalized })
    }

    for (const entry of committed) {
      try {
        if (entry.mutation.action === 'clear') await this.forget(entry.id)
        else {
          await this.vault.set(accountFor(entry.id), entry.value!)
          const validation = {
            fingerprint: fingerprint(entry.value!),
            configFingerprint: configFingerprint(credentialProvider(entry.id), candidateSettings),
            state: 'valid' as const,
            message: '凭据验证成功'
          }
          this.validations.set(entry.id, validation)
          await this.persistValidation(entry.id, validation)
        }
        if (entry.id !== 'parser') sharedModelRuntime.reset(entry.id)
      } catch {
        keyErrors[entry.id] = { code: 'CREDENTIAL_STORAGE_FAILED', message: '凭据存储失败，原有凭据未改变，请稍后重试' }
      }
    }

    // A key added in this save is kept only once its value is stored; removed keys leave the vault.
    const storedIds = new Set<string>()
    for (const connection of requested.filter(isKeyConnection)) {
      if (await this.vault.get(accountFor(connection.connectionId))) storedIds.add(connection.connectionId)
    }
    const connections = requested.filter(connection =>
      !isKeyConnection(connection) || storedIds.has(connection.connectionId) || before.some(value => value.connectionId === connection.connectionId))
    for (const removed of before.filter(value => isKeyConnection(value) && !connections.some(next => next.connectionId === value.connectionId))) {
      try {
        await this.forget(removed.connectionId)
        sharedModelRuntime.reset(removed.connectionId)
      } catch {
        keyErrors[removed.connectionId] = { code: 'CREDENTIAL_STORAGE_FAILED', message: '密钥删除失败，请稍后重试' }
        connections.push(removed)
      }
    }
    for (const connection of connections) {
      const previous = before.find(value => value.connectionId === connection.connectionId)
      if (previous && previous.enabled !== connection.enabled) sharedModelRuntime.reset(connection.connectionId)
    }

    const fieldErrors: Partial<Record<CredentialName, CredentialFieldError>> = {}
    const modelKeyErrors: Record<string, CredentialFieldError> = {}
    for (const [id, error] of Object.entries(keyErrors)) {
      if (id === 'parser') { fieldErrors.parser = error; continue }
      modelKeyErrors[id] = error
      const provider = credentialProvider(id) as KeyProvider
      if (id === `${provider}:default` && update.credentialMutations?.[provider]) fieldErrors[provider] = error
    }
    await this.repository.saveSettings({ ...candidateSettings, modelConnections: normalizeConnections(connections) })
    return {
      settings: await this.get(),
      fieldErrors,
      ...(Object.keys(modelKeyErrors).length ? { keyErrors: modelKeyErrors } : {})
    }
  }

  private async forget(id: CredentialId): Promise<void> {
    await this.vault.delete(accountFor(id))
    await this.vault.delete(validationAccountFor(id))
    this.validations.delete(id)
  }

  private statusFor(id: CredentialId, value: string | null, settings: AppSettings): CredentialStatus {
    if (!value) return { state: 'missing' }
    const maskedValue = maskCredential(value)
    const cached = this.validations.get(id)
    if (!cached || cached.fingerprint !== fingerprint(value) || cached.configFingerprint !== configFingerprint(credentialProvider(id), settings)) return { state: 'unknown', maskedValue }
    return {
      state: cached.state,
      maskedValue,
      ...(cached.errorCode ? { errorCode: cached.errorCode } : {}),
      ...(cached.message ? { message: cached.message } : {})
    }
  }

  private async persistValidation(id: CredentialId, validation: CachedValidation): Promise<void> {
    await this.vault.set(validationAccountFor(id), JSON.stringify({ version: 1, ...validation }))
  }

  private async restoreValidation(id: CredentialId, value: string | null, settings: AppSettings): Promise<void> {
    if (!value) {
      this.validations.delete(id)
      return
    }
    const raw = await this.vault.get(validationAccountFor(id))
    if (!raw) return
    try {
      const parsed = JSON.parse(raw) as Partial<CachedValidation> & { version?: unknown }
      if (parsed.version !== 1 || parsed.fingerprint !== fingerprint(value) ||
        parsed.configFingerprint !== configFingerprint(credentialProvider(id), settings) ||
        (parsed.state !== 'valid' && parsed.state !== 'invalid')) return
      this.validations.set(id, {
        fingerprint: parsed.fingerprint,
        configFingerprint: parsed.configFingerprint,
        state: parsed.state,
        ...(typeof parsed.errorCode === 'string' ? { errorCode: parsed.errorCode } : {}),
        ...(typeof parsed.message === 'string' ? { message: parsed.message } : {})
      })
    } catch {
      this.validations.delete(id)
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
    qwenChatModel: resolvePaperChatModel('qwen', settings.qwenChatModel),
    deepseekChatModel: resolvePaperChatModel('deepseek', settings.deepseekChatModel),
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
