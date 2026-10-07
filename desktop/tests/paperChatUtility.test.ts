import { BLOCK_MAPPING_VERSION } from '@core/blockMapping'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/constants'
import { paperChatPageSchema, paperChatSessionSchema } from '@shared/paperChatStorageSchemas'
import { paperChatStatusSchema, paperContextResultSchema } from '@shared/paperChatSchemas'
import { V2Database } from '../src/utility/core/persistence/v2Database'
import { SqliteRagRepository } from '../src/utility/core/persistence/sqliteRagRepository'
import { SqliteJobRepository } from '../src/utility/core/persistence/sqliteJobRepository'
import { V2TaskRepositoryCompat } from '../src/utility/core/persistence/v2TaskRepositoryCompat'
import { RagDomainService } from '../src/utility/core/ragDomainService'
import { RagContentIndexService } from '../src/utility/core/compute/ragContentIndexService'
import { createUtilityOperationHandlers } from '../src/utility/core/utilityOperations'

describe('paper chat Utility integration', () => {
  it('indexes an old document idempotently, builds bounded evidence through data RPC, and persists settings without migrations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilotix-paper-chat-'))
    const database = new V2Database(join(root, 'test.sqlite3'))
    try {
      const repository = new V2TaskRepositoryCompat(database)
      const rag = new SqliteRagRepository(database)
      const jobs = new SqliteJobRepository(database)
      const indexer = new RagContentIndexService(database, rag)
      const operations = createUtilityOperationHandlers({ database, repository, ragRepository: rag, ragService: new RagDomainService(database, rag, jobs), ragContentIndexService: indexer })
      const documentId = randomUUID()
      const now = new Date().toISOString()
      const text = '# Abstract\n\nAttention is the main contribution.\n'
      await writeFile(join(root, 'paper.md'), text, 'utf-8')
      const mappingText = JSON.stringify({ version: BLOCK_MAPPING_VERSION, mappings: [] })
      await writeFile(join(root, 'mappings.json'), mappingText, 'utf-8')
      database.connection.prepare('INSERT INTO documents(id,original_filename,display_title,storage_path,source_checksum,translation_provider,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(documentId, 'paper.pdf', null, root, 'source', 'qwen', now, now)
      const insert = database.connection.prepare('INSERT INTO artifacts(id,document_id,kind,revision,relative_path,content_hash,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)')
      insert.run(randomUUID(), documentId, 'parsed_markdown', 1, 'paper.md', createHash('sha256').update(text).digest('hex'), '{}', now)
      insert.run(randomUUID(), documentId, 'block_mappings', 1, 'mappings.json', createHash('sha256').update(mappingText).digest('hex'), '{}', now)
      const ensure = operations.handlers['chat:ensure-index']!
      const signal = new AbortController().signal
      expect(rag.getDocumentKnowledge(documentId)).toBeNull()
      const status = paperChatStatusSchema.parse(await ensure({ payload: { documentId } } as never, signal))
      expect(status.state).toBe('queued')
      await ensure({ payload: { documentId } } as never, signal)
      const rows = database.connection.prepare("SELECT payload_json FROM jobs WHERE document_id=? AND kind='rag-content-index'").all(documentId) as Array<{ payload_json: string }>
      expect(rows).toHaveLength(1)
      const revisionId = (JSON.parse(rows[0]!.payload_json) as { contentRevisionId: string }).contentRevisionId
      await indexer.index({ documentId, contentRevisionId: revisionId }, signal)
      expect(paperChatStatusSchema.parse(await ensure({ payload: { documentId } } as never, signal))).toMatchObject({ state: 'ready', progress: 100, contentRevisionId: revisionId })
      const context = paperContextResultSchema.parse(await operations.handlers['chat:build-context']!({ payload: { documentId, question: 'contribution', pinned: [], budgetChars: 48000 } } as never, signal))
      expect(context.evidence.map((e) => e.text).join('\n')).toContain('Attention')
      expect(context.evidence.every((e) => e.locator.contentRevisionId === revisionId)).toBe(true)
      const settings = repository.getSettings(root)
      expect(settings).toMatchObject({ chatProvider: null, qwenChatModel: DEFAULT_SETTINGS.qwenChatModel, chatConsentVersion: null })
      repository.saveSettings({ ...settings, chatProvider: 'qwen', qwenChatModel: 'custom-chat', chatConsentVersion: 1 })
      expect(repository.getSettings(root)).toMatchObject({ chatProvider: 'qwen', qwenChatModel: 'qwen-plus', chatConsentVersion: 1 })
      const turn = { id: randomUUID(), createdAt: now, provider: 'qwen', model: 'qwen-plus', question: 'saved question', answer: 'saved answer', citations: {}, status: 'completed' }
      await operations.handlers['chat:save-turn']!({ payload: { documentId, turn } } as never, signal)
      await operations.handlers['chat:save-session']!({ payload: { documentId, session: { draft: 'next question', pinned: [], selectedModel: null } } } as never, signal)
      const reopened = createUtilityOperationHandlers({ database, repository })
      expect(paperChatPageSchema.parse(await reopened.handlers['chat:load']!({ payload: { documentId } } as never, signal)).turns).toEqual([turn])
      expect(paperChatSessionSchema.parse(await reopened.handlers['chat:session']!({ payload: { documentId } } as never, signal)).draft).toBe('next question')
      await reopened.handlers['chat:clear']!({ payload: { documentId } } as never, signal)
      expect(paperChatPageSchema.parse(await reopened.handlers['chat:load']!({ payload: { documentId } } as never, signal)).turns).toEqual([])
      const migration = database.connection.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number }
      expect(migration.version).toBe(4)
      const cancelled = new AbortController(); cancelled.abort()
      await expect(ensure({ payload: { documentId } } as never, cancelled.signal)).rejects.toThrow()
      await expect(ensure({ payload: { documentId: randomUUID() } } as never, signal)).rejects.toMatchObject({ code: 'QUERY_SCOPE_INVALID' })
    } finally { database.close(); await rm(root, { recursive: true, force: true }) }
  })
})
