import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/constants'
import { normalizeEnabledProviders, normalizeProviderOrder, executableProviderOrder } from '@shared/providerPolicy'
import { paperChatSessionSchema } from '@shared/paperChatStorageSchemas'
import { ModelGateway } from '../src/main/chat/modelGateway'
import type { ChatProvider } from '../src/main/chat/chatProvider'
import type { CodexRuntime } from '../src/platform/codex/runtime/codexRuntime'
import { V2Database, V2_MIGRATIONS } from '../src/platform/database/utility/v2Database'

describe('Codex integration boundaries', () => {
  it('preserves old ordering without enabling Codex and falls back only to enabled providers', () => {
    const legacy = ['bing', 'qwen', 'transmart', 'deepseek']
    expect(normalizeProviderOrder(legacy, 'bing')).toEqual([...legacy, 'codex'])
    expect(normalizeEnabledProviders(undefined, [...DEFAULT_SETTINGS.translationProviderOrder])).not.toContain('codex')
    expect(executableProviderOrder(['codex', 'bing'], ['codex', 'bing'], DEFAULT_SETTINGS.credentials)).toEqual(['codex', 'bing'])
    expect(executableProviderOrder(['codex', 'qwen', 'bing'], ['codex'], { qwen: { state: 'valid' }, deepseek: { state: 'valid' } })).toEqual(['codex'])
    expect(executableProviderOrder(['codex', 'qwen', 'deepseek'], ['codex', 'qwen', 'deepseek'], { qwen: { state: 'invalid' }, deepseek: { state: 'valid' } })).toEqual(['codex', 'deepseek'])
  })
  it('preserves unavailable Codex model selections in saved history', () => {
    expect(paperChatSessionSchema.parse({ draft: '', pinned: [], selectedModel: { provider: 'codex', model: 'old-model' } }).selectedModel).toEqual({ provider: 'codex', model: 'old-model' })
  })
  it('routes text and images to Codex without a key and never falls back on failure', async () => {
    const cloud = { stream: vi.fn() }, codex = { generate: vi.fn().mockRejectedValue(new Error('offline')) }
    const gateway = new ModelGateway(cloud as unknown as ChatProvider, codex as unknown as CodexRuntime)
    await expect(gateway.stream({ provider: 'codex', model: 'model', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }], signal: new AbortController().signal, onDelta: () => undefined })).rejects.toThrow('offline')
    expect(codex.generate).toHaveBeenCalledOnce(); expect(cloud.stream).not.toHaveBeenCalled()
  })
  it('allows Codex facts in the migrated schema and preserves released checksums', () => {
    const database = new V2Database(':memory:')
    try {
      database.connection.prepare('INSERT INTO documents VALUES(?,?,?,?,?,?,?,?)').run('d', 'a.pdf', null, '/paper/d', 'hash', 'codex', 'now', 'now')
      database.connection.prepare('INSERT INTO translation_cache VALUES(?,?,?,?,?)').run('key', '译文', 'codex', 'model', 'now')
      expect(database.connection.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      expect(database.connection.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 })
      expect(database.migrationRows().at(-1)?.version).toBe(5)
      expect(V2_MIGRATIONS.at(-1)?.name).toBe('add-codex-provider')
    } finally { database.close() }
  })
})
