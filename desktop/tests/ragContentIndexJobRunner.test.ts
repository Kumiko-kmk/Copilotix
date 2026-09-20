import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { V2Database } from '../src/utility/core/persistence/v2Database'
import { SqliteRagRepository } from '../src/utility/core/persistence/sqliteRagRepository'
import { RagContentIndexService } from '../src/utility/core/compute/ragContentIndexService'
import { RagContentIndexJobRunner } from '../src/main/ragContentIndexJobRunner'
import type { JobRunnerInput } from '../src/core/jobs'
import { serializeCoreMessage } from '@shared/coreRpcSchemas'

const roots: string[] = []
const databases: V2Database[] = []
const now = '2026-01-01T00:00:00.000Z'
const sha = (value: string): string => createHash('sha256').update(value).digest('hex')

afterEach(async () => {
  for (const database of databases.splice(0)) database.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(markdown: string): Promise<{ database: V2Database; rag: SqliteRagRepository; service: RagContentIndexService; revisionId: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'copilotix-rag-index-'))
  roots.push(root)
  await mkdir(join(root, 'artifacts'), { recursive: true })
  const path = join(root, 'artifacts', 'paper.md')
  await writeFile(path, markdown, 'utf8')
  const database = new V2Database(join(root, 'db.sqlite3'))
  databases.push(database)
  database.connection.prepare(`INSERT INTO documents(id,original_filename,display_title,storage_path,source_checksum,translation_provider,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`).run('doc', 'paper.pdf', null, root, 'source', 'qwen', now, now)
  database.connection.prepare(`INSERT INTO artifacts(id,document_id,kind,revision,relative_path,content_hash,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)`).run('parsed', 'doc', 'parsed_markdown', 1, 'artifacts/paper.md', sha(markdown), '{}', now)
  const revisionId = 'revision-1'
  const rag = new SqliteRagRepository(database)
  rag.createContentRevision({ documentId: 'doc', artifactId: 'parsed', contentHash: sha(markdown), mappingFingerprint: 'mapping', chunkerFingerprint: 'chunker', contentRevisionId: revisionId, now })
  const service = new RagContentIndexService(database, rag)
  return { database, rag, service, revisionId, root }
}

describe('rag content index runner', () => {
  it('reads only registered artifacts and atomically publishes deterministic chunks', async () => {
    const value = await fixture('# Intro\n\n这是内容😀。')
    const first = await value.service.index({ documentId: 'doc', contentRevisionId: value.revisionId })
    const ids = value.rag.listChunks(value.revisionId).map((chunk) => [chunk.chunkId, chunk.contentHash])
    const second = await value.service.index({ documentId: 'doc', contentRevisionId: value.revisionId })
    expect(first).toEqual(second)
    expect(value.rag.listChunks(value.revisionId).map((chunk) => [chunk.chunkId, chunk.contentHash])).toEqual(ids)
    expect(value.rag.getDocumentKnowledge('doc')?.localState).toBe('ready')
  })

  it('marks only the replacement failed and keeps an older active revision usable', async () => {
    const value = await fixture('# New\n\ncontent')
    const old = value.rag.createContentRevision({ documentId: 'doc', artifactId: 'parsed', contentHash: 'old-hash', mappingFingerprint: 'old-map', chunkerFingerprint: 'old-chunker', contentRevisionId: 'old-revision', now })
    value.rag.transitionContentRevision({ contentRevisionId: old.contentRevisionId, state: 'ready', now })
    value.rag.upsertDocumentKnowledge({ documentId: 'doc', localState: 'ready', localProgress: 100, activeContentRevisionId: old.contentRevisionId, now })
    // A replacement pointing to an unregistered artifact fails; old content
    // remains addressable and the failure is isolated to the new revision.
    value.database.connection.prepare(`INSERT INTO artifacts(id,document_id,kind,revision,relative_path,content_hash,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)`).run('artifact-bad', 'doc', 'parsed_markdown', 2, 'artifacts/not-present.md', 'missing-hash', '{}', now)
    const failed = value.rag.createContentRevision({ documentId: 'doc', artifactId: 'artifact-bad', contentHash: 'missing-hash', mappingFingerprint: 'missing-map', chunkerFingerprint: 'missing-chunker', contentRevisionId: 'failed-revision', now })
    await expect(value.service.index({ documentId: 'doc', contentRevisionId: failed.contentRevisionId })).rejects.toThrow()
    expect(value.rag.getContentRevision(failed.contentRevisionId)?.state).toBe('failed')
    expect(value.rag.getDocumentKnowledge('doc')?.activeContentRevisionId).toBe(old.contentRevisionId)
    expect(value.rag.getDocumentKnowledge('doc')?.localState).toBe('ready')
    expect(value.rag.getDocumentKnowledge('doc')?.localProgress).toBe(100)
  })

  it('restores ready/queued projections on deterministic pre-cancel and mid-cancel paths', async () => {
    const value = await fixture('# Cancel\n\nbody')
    const controller = new AbortController()
    controller.abort()
    await expect(value.service.index({ documentId: 'doc', contentRevisionId: value.revisionId }, controller.signal)).rejects.toThrow('RAG_CONTENT_INDEX_CANCELLED')
    expect(value.rag.getDocumentKnowledge('doc')?.localState).toBe('unindexed')

    const old = value.rag.createContentRevision({ documentId: 'doc', artifactId: 'parsed', contentHash: 'old', mappingFingerprint: 'old-map', chunkerFingerprint: 'old-chunker', contentRevisionId: 'old-cancel-revision', now })
    value.rag.transitionContentRevision({ contentRevisionId: old.contentRevisionId, state: 'ready', now })
    value.rag.upsertDocumentKnowledge({ documentId: 'doc', localState: 'ready', localProgress: 100, activeContentRevisionId: old.contentRevisionId, now })
    // Keep the deterministic cancellation test on the same database by using
    // the first fixture's registered artifact and a custom path policy.
    const replacement = value.rag.createContentRevision({ documentId: 'doc', artifactId: 'parsed', contentHash: sha('# Cancel\n\nbody'), mappingFingerprint: 'cancel-map', chunkerFingerprint: 'cancel-chunker', contentRevisionId: 'cancel-replacement', now })
    const midController = new AbortController()
    const cancellingPolicy = { resolveChild: (root: string, candidate: string): string => { midController.abort(); return join(root, candidate) } }
    const cancellingService = new (RagContentIndexService)(value.database, value.rag, cancellingPolicy)
    await expect(cancellingService.index({ documentId: 'doc', contentRevisionId: replacement.contentRevisionId }, midController.signal)).rejects.toThrow('RAG_CONTENT_INDEX_CANCELLED')
    expect(value.rag.getContentRevision(replacement.contentRevisionId)?.state).toBe('building')
    expect(value.rag.getDocumentKnowledge('doc')?.localState).toBe('ready')
    expect(value.rag.getDocumentKnowledge('doc')?.activeContentRevisionId).toBe(old.contentRevisionId)
    const retried = await value.service.index({ documentId: 'doc', contentRevisionId: replacement.contentRevisionId })
    expect(retried.revisionState).toBe('ready')
    expect(value.rag.getDocumentKnowledge('doc')?.activeContentRevisionId).toBe(replacement.contentRevisionId)
  })

  it('restores queued state after a deterministic mid-cancel without an old active revision', async () => {
    const value = await fixture('# Cancel\n\nbody')
    const controller = new AbortController()
    const cancellingPolicy = { resolveChild: (root: string, candidate: string): string => { controller.abort(); return join(root, candidate) } }
    const cancellingService = new RagContentIndexService(value.database, value.rag, cancellingPolicy)
    await expect(cancellingService.index({ documentId: 'doc', contentRevisionId: value.revisionId }, controller.signal))
      .rejects.toThrow('RAG_CONTENT_INDEX_CANCELLED')
    expect(value.rag.getContentRevision(value.revisionId)?.state).toBe('building')
    expect(value.rag.getDocumentKnowledge('doc')).toMatchObject({ localState: 'queued', localProgress: 0, activeContentRevisionId: null })
    await value.service.index({ documentId: 'doc', contentRevisionId: value.revisionId })
    expect(value.rag.getContentRevision(value.revisionId)?.state).toBe('ready')
    expect(value.rag.getDocumentKnowledge('doc')).toMatchObject({ localState: 'ready', localProgress: 100, activeContentRevisionId: value.revisionId })
  })

  it('preserves deterministic mapping JSON errors as non-retryable at the Utility service boundary', async () => {
    const value = await fixture('# Mapping\n\nbody')
    const raw = '{invalid-json'
    const mappingPath = join(value.root, 'artifacts', 'bad-mappings.json')
    await writeFile(mappingPath, raw, 'utf8')
    const mappingHash = sha(raw)
    value.database.connection.prepare(`INSERT INTO artifacts(id,document_id,kind,revision,relative_path,content_hash,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)`).run(
      'bad-mappings', 'doc', 'block_mappings', 1, 'artifacts/bad-mappings.json', mappingHash, '{}', now
    )
    const revision = value.rag.createContentRevision({
      documentId: 'doc', artifactId: 'parsed', contentHash: sha('# Mapping\n\nbody'), mappingFingerprint: mappingHash,
      chunkerFingerprint: 'chunker', contentRevisionId: 'invalid-mappings', now
    })
    await expect(value.service.index({ documentId: 'doc', contentRevisionId: revision.contentRevisionId }))
      .rejects.toMatchObject({ code: 'RAG_BLOCK_MAPPING_INVALID_JSON', retryable: false })
  })

  it('runner reports chunking metadata and never sends source text through its facade', async () => {
    const value = await fixture('## Section\n\nBody')
    const runner = new RagContentIndexJobRunner({ index: (documentId, contentRevisionId) => value.service.index({ documentId, contentRevisionId }) })
    const progress: unknown[] = []
    const input = {
      job: { id: 'job', documentId: 'doc', kind: 'rag-content-index', status: 'running', progress: 0, priority: 0, attempt: 1, maxAttempts: 3, payload: { contentRevisionId: value.revisionId }, checkpoint: {}, availableAt: now, dependsOnJobId: null, leaseOwner: 'owner', leaseExpiresAt: now, errorCode: null, errorMessage: null, createdAt: now, updatedAt: now, startedAt: now, finishedAt: null },
      signal: new AbortController().signal,
      updateProgress: async (percent: number, checkpoint: Record<string, unknown>) => { progress.push([percent, checkpoint]); return input.job }
    } satisfies JobRunnerInput
    const result = await runner.run(input)
    expect(result).toMatchObject({ status: 'succeeded', progress: 100, detail: { contentRevisionId: value.revisionId } })
    expect(progress).toHaveLength(1)
  })

  it('keeps the content-index RPC metadata-only and strict', () => {
    const base = { version: 1 as const, requestId: '00000000-0000-4000-8000-000000000001', operation: 'compute:rag-content-index' as const, payload: { documentId: 'doc', contentRevisionId: 'revision' } }
    expect(() => serializeCoreMessage({ ...base, payload: { ...base.payload, sourceText: 'secret' } })).toThrow()
    expect(() => serializeCoreMessage({ ...base, payload: { documentId: 'doc', contentRevisionId: 'x'.repeat(513) } })).toThrow()
    expect(() => serializeCoreMessage({ ...base, operation: 'compute:unknown' })).toThrow()
  })

  it('preserves deterministic error retryability at the job boundary', async () => {
    const runner = new RagContentIndexJobRunner({
      index: async () => { throw Object.assign(new Error('content hash mismatch'), { code: 'RAG_CONTENT_HASH_MISMATCH', retryable: false }) }
    })
    const input = {
      job: { id: 'job-error', documentId: 'doc', kind: 'rag-content-index', status: 'running', progress: 0, priority: 0, attempt: 1, maxAttempts: 3, payload: { contentRevisionId: 'rev' }, checkpoint: {}, availableAt: now, dependsOnJobId: null, leaseOwner: 'owner', leaseExpiresAt: now, errorCode: null, errorMessage: null, createdAt: now, updatedAt: now, startedAt: now, finishedAt: null },
      signal: new AbortController().signal,
      updateProgress: async () => input.job
    } satisfies JobRunnerInput
    await expect(runner.run(input)).rejects.toMatchObject({ code: 'RAG_CONTENT_HASH_MISMATCH', retryable: false })
  })
})
