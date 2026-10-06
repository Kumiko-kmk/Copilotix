import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/constants'
import type { AppSettings, HealthResult, SettingsUpdate } from '@shared/types'
import type { CredentialAccount, CredentialVault } from '../src/main/credentialVault'
import { maskCredential, SettingsService, TRANSLATION_CREDENTIAL_RESET_MIGRATION, type SettingsRepositoryPort } from '../src/main/settingsService'

const roots: string[] = []

afterEach(() => {
  roots.splice(0)
})

describe('SettingsService credential isolation', () => {
  it('validates candidates before writing and commits fields independently', async () => {
    const repository = new SettingsRepository()
    const vault = new MemoryVault({
      'parser-token': 'parser-old',
      'qwen-api-key': 'qwen-old',
      'deepseek-api-key': 'deepseek-old'
    })
    const service = new SettingsService(repository, vault, 'C:\\output', {
      parser: async (value) => valid(value === 'parser-new'),
      provider: async (name, value) => name === 'deepseek' ? valid(value === 'deepseek-new') : valid(value === 'qwen-new')
    })

    const result = await service.save({
      ...publicUpdate(),
      credentialMutations: {
        parser: { action: 'set', value: ' parser-new ' },
        qwen: { action: 'set', value: 'wrong-qwen' },
        deepseek: { action: 'set', value: 'deepseek-new' }
      }
    })

    expect(vault.values.get('parser-token')).toBe('parser-new')
    expect(vault.values.get('qwen-api-key')).toBe('qwen-old')
    expect(vault.values.get('deepseek-api-key')).toBe('deepseek-new')
    expect(result.fieldErrors).toEqual({
      qwen: { code: 'CREDENTIAL_INVALID', message: '凭据验证失败' }
    })
    expect(result.settings.credentials.parser).toMatchObject({ state: 'valid', maskedValue: 'pa****ew' })
    expect(result.settings.credentials.qwen).toMatchObject({ state: 'unknown', maskedValue: 'qw****ld' })
    expect(result.settings.credentials.deepseek).toMatchObject({ state: 'valid', maskedValue: 'deeps****k-new' })
    expect(repository.saved).toHaveLength(1)
    expect(JSON.stringify(repository.saved[0])).not.toContain('parser-new')
    expect(JSON.stringify(repository.saved[0])).not.toContain('deepseek-new')
  })

  it('does not write candidates when validation is unavailable and supports explicit clear', async () => {
    const repository = new SettingsRepository()
    const vault = new MemoryVault({ 'qwen-api-key': 'qwen-old' })
    const service = new SettingsService(repository, vault, 'C:\\output', {
      parser: async () => valid(true),
      provider: async () => ({ ok: false, code: 'HTTP_503', message: 'service unavailable' })
    })

    const unavailable = await service.save({
      ...publicUpdate(),
      credentialMutations: { qwen: { action: 'set', value: 'qwen-new' } }
    })
    expect(unavailable.fieldErrors.qwen).toMatchObject({ code: 'CREDENTIAL_VALIDATION_UNAVAILABLE' })
    expect(vault.values.get('qwen-api-key')).toBe('qwen-old')
    expect(repository.saved).toHaveLength(1)

    const cleared = await service.save({
      ...publicUpdate(),
      credentialMutations: { qwen: { action: 'clear' } }
    })
    expect(cleared.fieldErrors).toEqual({})
    expect(vault.values.has('qwen-api-key')).toBe(false)
    expect(cleared.settings.credentials.qwen).toEqual({ state: 'missing' })
  })

  it('restores validated credentials across restart from a versioned vault receipt', async () => {
    const repository = new SettingsRepository()
    const vault = new MemoryVault({ 'parser-token': 'parser-secret' })
    const probe = { parser: async () => valid(true), provider: async () => valid(true) }
    const first = new SettingsService(repository, vault, 'C:\\output', probe)
    await first.validateCredential('parser')
    await expect(first.get()).resolves.toMatchObject({ credentials: { parser: { state: 'valid', maskedValue: 'parse****ecret' } } })

    const second = new SettingsService(repository, vault, 'C:\\output', probe)
    await expect(second.get()).resolves.toMatchObject({ credentials: { parser: { state: 'valid', maskedValue: 'parse****ecret' } } })
  })

  it('persists a definitive validation failure but not raw credential material', async () => {
    const repository = new SettingsRepository()
    const vault = new MemoryVault({ 'deepseek-api-key': 'deepseek-secret' })
    const first = new SettingsService(repository, vault, 'C:\\output', {
      provider: async () => ({ ok: false, code: 'HTTP_401', message: '密钥无效' })
    })

    await expect(first.validateCredential('deepseek')).resolves.toMatchObject({ state: 'invalid', errorCode: 'CREDENTIAL_INVALID' })
    const receipt = vault.values.get('deepseek-api-key-validation')!
    expect(receipt).not.toContain('deepseek-secret')
    await expect(new SettingsService(repository, vault, 'C:\\output').get()).resolves.toMatchObject({
      credentials: { deepseek: { state: 'invalid', errorCode: 'CREDENTIAL_INVALID', maskedValue: 'deeps****ecret' } }
    })
  })

  it('keeps provider endpoints and models on internal defaults', async () => {
    const repository = new SettingsRepository()
    const vault = new MemoryVault({ 'qwen-api-key': 'qwen-secret' })
    const service = new SettingsService(repository, vault, 'C:\\output', {
      provider: async () => valid(true)
    })
    await service.validateCredential('qwen')
    await expect(new SettingsService(repository, vault, 'C:\\output').get()).resolves.toMatchObject({
      credentials: { qwen: { state: 'valid' } }
    })

    const update = publicUpdate()
    const changed = await service.save({
      ...update,
      qwenBaseUrl: 'https://untrusted.example/v1',
      qwenModel: 'custom-qwen',
      deepseekBaseUrl: 'https://untrusted.example/deepseek',
      deepseekModel: 'custom-deepseek'
    })
    expect(changed.settings).toMatchObject({
      qwenBaseUrl: DEFAULT_SETTINGS.qwenBaseUrl,
      qwenModel: DEFAULT_SETTINGS.qwenModel,
      deepseekBaseUrl: DEFAULT_SETTINGS.deepseekBaseUrl,
      deepseekModel: DEFAULT_SETTINGS.deepseekModel,
      credentials: { qwen: { state: 'valid' } }
    })
    expect(vault.values.has('qwen-api-key-validation')).toBe(true)
  })

  it('distinguishes stale proxy failures from invalid credentials and preserves configuration errors', async () => {
    const repository = new SettingsRepository()
    const vault = new MemoryVault({})
    let failure: HealthResult = { ok: false, code: 'PROXY_AUTH_REQUIRED', message: '网络代理要求身份验证，请检查或关闭代理后重试' }
    const service = new SettingsService(repository, vault, 'C:\\output', {
      provider: async () => failure
    })

    await expect(service.validateCredential('qwen', 'candidate-key')).resolves.toEqual({
      state: 'unknown',
      errorCode: 'CREDENTIAL_VALIDATION_UNAVAILABLE',
      message: '网络代理要求身份验证，请检查或关闭代理后重试'
    })

    failure = { ok: false, code: 'PROVIDER_CONFIGURATION_INVALID', message: 'qwen 服务地址或模型配置不可用（HTTP 400）' }
    await expect(service.validateCredential('qwen', 'candidate-key')).resolves.toEqual({
      state: 'invalid',
      errorCode: 'PROVIDER_CONFIGURATION_INVALID',
      message: 'qwen 服务地址或模型配置不可用（HTTP 400）'
    })
  })

  it('reports vault write failures per field while saving other fields and public settings', async () => {
    const repository = new SettingsRepository()
    const vault = new MemoryVault({})
    vault.failSet.add('qwen-api-key')
    const service = new SettingsService(repository, vault, 'C:\\output', {
      parser: async () => valid(true),
      provider: async () => valid(true)
    })

    const result = await service.save({
      ...publicUpdate(),
      credentialMutations: {
        parser: { action: 'set', value: 'parser-new' },
        qwen: { action: 'set', value: 'qwen-new' }
      }
    })
    expect(result.fieldErrors).toMatchObject({ qwen: { code: 'CREDENTIAL_STORAGE_FAILED' } })
    expect(vault.values.get('parser-token')).toBe('parser-new')
    expect(vault.values.has('qwen-api-key')).toBe(false)
    expect(repository.saved).toHaveLength(1)
  })

  it('preserves existing translation credentials and records the migration once', async () => {
    const repository = new SettingsRepository()
    repository.migrationMarkers.add('translation-credentials-reset-v1')
    const initialCredentials = {
      'parser-token': 'parser-secret',
      'qwen-api-key': 'old-qwen',
      'deepseek-api-key': 'old-deepseek',
      'qwen-api-key-validation': 'qwen-validation-receipt',
      'deepseek-api-key-validation': 'deepseek-validation-receipt'
    } as const
    const vault = new MemoryVault(initialCredentials)
    const service = new SettingsService(repository, vault, 'C:\\output')

    await service.initialize()
    expect(vault.values).toEqual(new Map(Object.entries(initialCredentials)))
    expect(repository.migrationMarker).toBe(true)
    expect(repository.migrationMarkers.has(TRANSLATION_CREDENTIAL_RESET_MIGRATION)).toBe(true)
    expect(vault.deleteCalls).toBe(0)
    const entriesAfterFirstRun = [...vault.values]
    await service.initialize()
    expect([...vault.values]).toEqual(entriesAfterFirstRun)
    expect(vault.deleteCalls).toBe(0)
    expect(repository.markerCalls).toBe(1)
    expect(repository.migrationId).toBe(TRANSLATION_CREDENTIAL_RESET_MIGRATION)
  })

  it('retries a failed migration marker write without changing credentials', async () => {
    const repository = new SettingsRepository()
    const initialCredentials = { 'qwen-api-key': 'old-qwen', 'deepseek-api-key': 'old-deepseek' }
    const vault = new MemoryVault(initialCredentials)
    repository.failMarkMigration = true
    const service = new SettingsService(repository, vault, 'C:\\output')

    await expect(service.initialize()).resolves.toBeUndefined()
    expect(repository.migrationMarker).toBe(false)
    expect(vault.values).toEqual(new Map(Object.entries(initialCredentials)))
    expect(vault.deleteCalls).toBe(0)

    repository.failMarkMigration = false
    await service.initialize()
    expect(repository.migrationMarker).toBe(true)
    expect(vault.values).toEqual(new Map(Object.entries(initialCredentials)))
    expect(vault.deleteCalls).toBe(0)
  })
})

describe('credential masking', () => {
  it.each([
    ['abcdefghijkl', 'abcde****hijkl'],
    ['abcdefghij', 'ab****ij'],
    ['abcde', 'ab****de'],
    ['abcd', '****'],
    ['abc', '****']
  ])('masks %s as %s', (value, expected) => {
    expect(maskCredential(value)).toBe(expected)
  })
})

function valid(ok: boolean): HealthResult {
  return ok ? { ok: true, message: '验证成功' } : { ok: false, message: '凭据验证失败' }
}

function publicUpdate(): SettingsUpdate {
  const { credentials: _credentials, ...settings } = baseSettings()
  return settings
}

function baseSettings(): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    outputRoot: 'C:\\output',
    credentials: {
      parser: { state: 'missing' },
      qwen: { state: 'missing' },
      deepseek: { state: 'missing' }
    }
  }
}

class SettingsRepository implements SettingsRepositoryPort {
  readonly saved: AppSettings[] = []
  migrationMarker = false
  migrationId: string | undefined
  markerCalls = 0
  failMarkMigration = false
  readonly migrationMarkers = new Set<string>()
  private settings = baseSettings()

  async getSettings(outputRoot: string): Promise<AppSettings> {
    return { ...this.settings, outputRoot: this.settings.outputRoot || outputRoot, credentials: baseSettings().credentials }
  }
  async saveSettings(settings: AppSettings): Promise<void> {
    this.saved.push(settings)
    this.settings = { ...settings, credentials: baseSettings().credentials }
  }
  async getMigrationMarker(id: string): Promise<boolean> { return this.migrationMarkers.has(id) }
  async markMigration(id: string): Promise<void> {
    this.markerCalls += 1
    if (this.failMarkMigration) throw new Error('migration marker store unavailable')
    this.migrationMarker = true
    this.migrationId = id
    this.migrationMarkers.add(id)
  }
}

class MemoryVault implements CredentialVault {
  readonly values: Map<CredentialAccount, string>
  readonly failSet = new Set<CredentialAccount>()
  readonly failDelete = new Set<CredentialAccount>()
  deleteCalls = 0

  constructor(values: Partial<Record<CredentialAccount, string>>) {
    this.values = new Map(Object.entries(values) as Array<[CredentialAccount, string]>)
  }

  async get(account: CredentialAccount): Promise<string | null> { return this.values.get(account) ?? null }
  async set(account: CredentialAccount, value: string): Promise<void> {
    if (this.failSet.has(account)) throw new Error('credential store unavailable')
    this.values.set(account, value)
  }
  async delete(account: CredentialAccount): Promise<void> {
    this.deleteCalls += 1
    if (this.failDelete.has(account)) throw new Error('credential store unavailable')
    this.values.delete(account)
  }
  async has(account: CredentialAccount): Promise<boolean> { return this.values.has(account) }
}


describe('paper chat settings authorization', () => {
  it('keeps models independent and revokes consent whenever the recipient changes', async () => {
    const repository = new SettingsRepository()
    const service = new SettingsService(repository, new MemoryVault({}), 'C:/papers')
    const selected = await service.save({ ...publicUpdate(), chatProvider: null, qwenChatModel: 'custom-chat', chatConsentVersion: 2 })
    expect(selected.settings).toMatchObject({ chatProvider: null, chatConsentVersion: 2, qwenChatModel: 'custom-chat', qwenModel: DEFAULT_SETTINGS.qwenModel })
    const changed = await service.save({ ...publicUpdate(), translationProviderOrder: ['deepseek', 'qwen', 'bing', 'transmart'], chatConsentVersion: 2 })
    expect(changed.settings.translationProvider).toBe('deepseek')
    expect(changed.settings.chatConsentVersion).toBeNull()
  })
})
