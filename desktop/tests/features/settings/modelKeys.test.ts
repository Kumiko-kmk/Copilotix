import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@features/settings/contract/defaultSettings'
import type { AppSettings, SettingsUpdate } from '@features/settings/contract/settingsTypes'
import { settingsUpdateSchema } from '@features/settings/contract/settingsSchemas'
import type { CredentialAccount, CredentialVault } from '@platform/credentials/main/credentialVault'
import { createConnection, modelConnectionSchema, type ModelConnection } from '@platform/models/contract/models'
import { ModelRuntime, keyConnection, sharedModelRuntime } from '@platform/models/runtime/modelRuntime'
import { SettingsService, type SettingsRepositoryPort } from '../../../src/features/settings/main/settingsService'
import { coreProtocol } from '@app/contract/coreRpc'
import { CORE_RPC_VERSION } from '@platform/rpc/contract/protocol'

const EXTRA = 'qwen:11111111-2222-4333-8444-555555555555'
const SECOND = 'qwen:66666666-7777-4888-8999-aaaaaaaaaaaa'

describe('multiple model keys', () => {
  it('validates and stores an added key under its own account and routes keys in order', async () => {
    const { service, vault } = fixture({ 'qwen-api-key': 'qwen-default' })
    await service.validateCredential('qwen')
    const result = await service.save(update([key('qwen:default'), key(EXTRA, '备用')], { [EXTRA]: { action: 'set', value: ' qwen-extra ' } }))

    expect(result.keyErrors).toBeUndefined()
    expect(vault.values.get(`api-key:${EXTRA.slice(5)}`)).toBe('qwen-extra')
    expect(result.settings.modelConnections?.filter(value => value.provider === 'qwen').map(value => [value.connectionId, value.label])).toEqual([['qwen:default', undefined], [EXTRA, '备用']])
    expect(result.settings.keyStatuses).toMatchObject({ 'qwen:default': { state: 'valid' }, [EXTRA]: { state: 'valid', maskedValue: 'qw****ra' } })
    expect((await service.providerKeys('qwen')).map(entry => [entry.connection.connectionId, entry.key])).toEqual([['qwen:default', 'qwen-default'], [EXTRA, 'qwen-extra']])

    // Reordering and disabling change the request order without touching stored values.
    await service.save(update([{ ...key(EXTRA, '备用') }, { ...key('qwen:default'), enabled: false }]))
    expect((await service.providerKeys('qwen')).map(entry => entry.connection.connectionId)).toEqual([EXTRA])
    expect(vault.values.get('qwen-api-key')).toBe('qwen-default')
  })

  it('drops a new key whose value fails validation and keeps the key set otherwise unchanged', async () => {
    const { service, vault, repository } = fixture({ 'qwen-api-key': 'qwen-default' }, value => value !== 'bad-key')
    const result = await service.save(update([key('qwen:default'), key(EXTRA)], { [EXTRA]: { action: 'set', value: 'bad-key' } }))
    expect(result.keyErrors?.[EXTRA]).toMatchObject({ code: 'CREDENTIAL_INVALID' })
    expect(result.fieldErrors).toEqual({})
    expect([...vault.values.keys()].some(account => account.startsWith('api-key:'))).toBe(false)
    expect(repository.current.modelConnections?.map(value => value.connectionId)).not.toContain(EXTRA)
  })

  it('removes a deleted key and its validation receipt from the vault', async () => {
    const { service, vault } = fixture({ 'qwen-api-key': 'qwen-default' })
    await service.save(update([key('qwen:default'), key(EXTRA)], { [EXTRA]: { action: 'set', value: 'qwen-extra' } }))
    expect(vault.values.has(`api-key:${EXTRA.slice(5)}-validation` as CredentialAccount)).toBe(true)
    const removed = await service.save(update([key('qwen:default')]))
    expect([...vault.values.keys()].filter(account => account.startsWith('api-key:'))).toEqual([])
    expect(removed.settings.modelConnections?.map(value => value.connectionId)).not.toContain(EXTRA)
  })

  it('marks only the rejected key invalid; the provider stays usable through the others', async () => {
    const { service } = fixture({ 'qwen-api-key': 'qwen-default' })
    await service.save(update([key('qwen:default'), key(EXTRA)], { 'qwen:default': { action: 'set', value: 'qwen-default' }, [EXTRA]: { action: 'set', value: 'qwen-extra' } }))
    await service.invalidateKey('qwen:default')
    const settings = await service.get()
    expect(settings.keyStatuses?.['qwen:default']).toMatchObject({ state: 'invalid' })
    expect(settings.keyStatuses?.[EXTRA]).toMatchObject({ state: 'valid' })
    expect(settings.credentials.qwen.state).toBe('valid')
    expect((await service.providerKeys('qwen')).map(entry => entry.connection.connectionId)).toEqual([EXTRA])
  })

  it('reports live cooldown and hides a default key that was never filled in', async () => {
    const { service } = fixture({ 'qwen-api-key': 'qwen-default' })
    await service.validateCredential('qwen')
    const run = sharedModelRuntime.run(keyConnection(createConnection('qwen', 'qwen:default', 0), 'qwen-default'), 'background', new AbortController().signal, async () => { throw Object.assign(new Error('busy'), { status: 503 }) })
    await expect(run).rejects.toThrow('busy')
    const settings = await service.get()
    expect(settings.keyStatuses?.['qwen:default']).toMatchObject({ health: 'cooldown' })
    expect(settings.modelConnections?.map(value => value.connectionId)).not.toContain('deepseek:default')
    sharedModelRuntime.reset('qwen:default')
  })
})

describe('model key contract', () => {
  it('derives the vault account from the id so a renderer cannot point a key at another secret', () => {
    expect(modelConnectionSchema.safeParse(createConnection('qwen', EXTRA, 1)).success).toBe(true)
    expect(modelConnectionSchema.safeParse({ ...createConnection('qwen', EXTRA, 1), credentialRef: 'parser-token' }).success).toBe(false)
    expect(modelConnectionSchema.safeParse({ ...createConnection('qwen', EXTRA, 1), provider: 'deepseek', endpoint: 'https://api.deepseek.com', quotaGroup: 'deepseek' }).success).toBe(false)
    expect(modelConnectionSchema.safeParse({ ...createConnection('qwen', 'qwen:../parser', 1) }).success).toBe(false)
  })

  it('accepts a save built from getSettings() and drops the derived key statuses', () => {
    const parsed = settingsUpdateSchema.parse({ ...update([key('qwen:default')]), keyStatuses: { 'qwen:default': { state: 'valid' } } })
    expect(parsed).not.toHaveProperty('keyStatuses', expect.anything())
  })

  it('persists through the Core RPC envelope when the renderer sends undefined labels and statuses', async () => {
    const { service, repository } = fixture({})
    const sent: string[] = []
    repository.onSave = settings => {
      const request = coreProtocol.requestSchema.parse({ version: CORE_RPC_VERSION, requestId: '00000000-0000-4000-8000-000000000001', operation: 'settings:save', payload: { settings } })
      sent.push(coreProtocol.serializeMessage(request))
    }
    const parsed = settingsUpdateSchema.parse({ ...update([{ ...key(EXTRA), label: undefined }], { [EXTRA]: { action: 'set', value: 'qwen-extra' } }), keyStatuses: {} })
    await service.save(parsed)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain(EXTRA)
  })

  it('caps each provider at five keys', () => {
    const ids = Array.from({ length: 6 }, (_, index) => `qwen:${String(index).repeat(8)}-0000-4000-8000-000000000000`)
    const base = update(ids.slice(0, 5).map(id => key(id)))
    expect(settingsUpdateSchema.safeParse(base).success).toBe(true)
    expect(settingsUpdateSchema.safeParse(update(ids.map(id => key(id)))).success).toBe(false)
  })
})

describe('runtime fallback across keys', () => {
  it('moves to the next key after a rejection, reports it once and never retries the same key', async () => {
    const runtime = new ModelRuntime(() => 0)
    const rejected = vi.fn()
    runtime.onCredentialRejected(rejected)
    const first = keyConnection(createConnection('qwen', 'qwen:default', 0), 'a')
    const second = keyConnection(createConnection('qwen', SECOND, 1), 'b')
    const calls: string[] = []
    const result = await runtime.execute({ purpose: 'translation', model: 'm', lane: 'background', candidates: [first, second], signal: new AbortController().signal }, async connection => {
      calls.push(connection.connectionId)
      if (connection.connectionId === 'qwen:default') throw Object.assign(new Error('denied'), { status: 401 })
      return { value: 'ok', usage: null }
    })
    expect(result).toMatchObject({ value: 'ok', connectionId: SECOND })
    expect(calls).toEqual(['qwen:default', SECOND])
    await vi.waitFor(() => expect(rejected).toHaveBeenCalledWith('qwen:default'))
    // The rejected key is skipped without a request until its key or settings change.
    calls.length = 0
    await runtime.execute({ purpose: 'translation', model: 'm', lane: 'background', candidates: [first, second], signal: new AbortController().signal }, async connection => { calls.push(connection.connectionId); return { value: 'ok', usage: null } })
    expect(calls).toEqual([SECOND])
    expect(rejected).toHaveBeenCalledTimes(1)
  })
})

function key(id: string, label?: string): ModelConnection {
  return createConnection('qwen', id, 0, label)
}

function update(qwenKeys: ModelConnection[], keyMutations?: SettingsUpdate['keyMutations']): SettingsUpdate {
  const { credentials: _credentials, keyStatuses: _keyStatuses, ...settings } = baseSettings()
  return { ...settings, modelConnections: [...qwenKeys, createConnection('codex', 'codex:default', 0)], ...(keyMutations ? { keyMutations } : {}) }
}

function baseSettings(): AppSettings {
  return { ...DEFAULT_SETTINGS, outputRoot: 'C:\\output', credentials: { parser: { state: 'missing' }, qwen: { state: 'missing' }, deepseek: { state: 'missing' } } }
}

function fixture(values: Partial<Record<CredentialAccount, string>>, accept: (value: string) => boolean = () => true) {
  const repository = new Repository()
  const vault = new MemoryVault(values)
  const service = new SettingsService(repository, vault, 'C:\\output', {
    parser: async () => ({ ok: true, message: 'ok' }),
    provider: async (_name, value) => accept(value) ? { ok: true, message: 'ok' } : { ok: false, message: '凭据验证失败' }
  })
  return { service, vault, repository }
}

class Repository implements SettingsRepositoryPort {
  current = baseSettings()
  onSave?: (settings: AppSettings) => void
  async getSettings(): Promise<AppSettings> { return structuredClone(this.current) }
  async saveSettings(settings: AppSettings): Promise<void> { this.onSave?.(settings); this.current = { ...settings, credentials: baseSettings().credentials } }
  async getMigrationMarker(): Promise<boolean> { return true }
  async markMigration(): Promise<void> {}
}

class MemoryVault implements CredentialVault {
  readonly values: Map<CredentialAccount, string>
  constructor(values: Partial<Record<CredentialAccount, string>>) { this.values = new Map(Object.entries(values) as Array<[CredentialAccount, string]>) }
  async get(account: CredentialAccount): Promise<string | null> { return this.values.get(account) ?? null }
  async set(account: CredentialAccount, value: string): Promise<void> { this.values.set(account, value) }
  async delete(account: CredentialAccount): Promise<void> { this.values.delete(account) }
  async has(account: CredentialAccount): Promise<boolean> { return this.values.has(account) }
}
