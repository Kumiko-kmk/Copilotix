import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RagChunk } from '@core/types'
import { V2Database } from '../src/platform/database/utility/v2Database'
import { SqliteRagRepository } from '../src/utility/core/persistence/sqliteRagRepository'

const directories: string[] = []
const now = '2026-01-01T00:00:00.000Z'

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture(): Promise<{ database: V2Database; repository: SqliteRagRepository }> {
  const directory = await mkdtemp(join(tmpdir(), 'copilotix-rag-'))
  directories.push(directory)
  const database = new V2Database(join(directory, 'rag.sqlite3'))
  database.connection.prepare(`
    INSERT INTO documents(
      id,original_filename,display_title,storage_path,source_checksum,
      translation_provider,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?)
  `).run('document-1', 'paper.pdf', null, 'C:/documents/document-1', 'document-hash', 'qwen', now, now)
  const artifact = database.connection.prepare(`
    INSERT INTO artifacts(id,document_id,kind,revision,relative_path,content_hash,metadata_json,created_at)
    VALUES(?,?,?,?,?,?,?,?)
  `)
  artifact.run('artifact-1', 'document-1', 'parsed_markdown', 1, 'paper.md', 'artifact-hash', '{}', now)
  artifact.run('artifact-2', 'document-1', 'parsed_markdown', 2, 'paper-retry.md', 'artifact-retry-hash', '{}', now)
  return { database, repository: new SqliteRagRepository(database) }
}

function chunk(overrides: Partial<RagChunk> = {}): RagChunk {
  return {
    chunkId: 'chunk-1',
    contentRevisionId: 'revision-1',
    ordinal: 0,
    contentHash: 'chunk-hash',
    sourceText: 'A source paragraph.',
    sectionPath: ['Introduction'],
    mappingIds: ['mapping-1'],
    pageStart: 1,
    pageEnd: 1,
    sourceStartOffset: 0,
    sourceEndOffset: 19,
    offsetUnit: 'utf16',
    tokenCount: 4,
    contentType: 'paragraph',
    mappingConfidence: 'exact',
    ...overrides
  }
}

function createRevision(repository: SqliteRagRepository, contentRevisionId = 'revision-1', contentHash = 'content-hash') {
  return repository.createContentRevision({
    documentId: 'document-1',
    artifactId: 'artifact-1',
    contentHash,
    mappingFingerprint: 'mapping-fingerprint',
    chunkerFingerprint: 'chunker-v1',
    contentRevisionId,
    now
  })
}

describe('SqliteRagRepository', () => {
  it('creates an idempotent knowledge row for an existing document only', async () => {
    const { database, repository } = await fixture()
    try {
      expect(repository.getDocumentKnowledge('document-1')).toBeNull()
      expect(repository.ensureDocumentKnowledge('document-1', now)).toMatchObject({
        documentId: 'document-1',
        localState: 'unindexed',
        activeContentRevisionId: null
      })
      expect(repository.ensureDocumentKnowledge('document-1', now)).toEqual(repository.getDocumentKnowledge('document-1'))
      expect(() => repository.ensureDocumentKnowledge('missing-document', now)).toThrowError(
        expect.objectContaining({ code: 'DOCUMENT_NOT_FOUND' })
      )
      expect(() => repository.upsertDocumentKnowledge({ documentId: 'document-1', localState: 'ready', localProgress: 100, now })).toThrowError(
        expect.objectContaining({ code: 'RAG_INVALID_LOCAL_STATE' })
      )
      expect(repository.getDocumentKnowledge('document-1')).toMatchObject({ localState: 'unindexed' })
    } finally {
      database.close()
    }
  })

  it('deduplicates content revisions and publishes canonical chunks atomically', async () => {
    const { database, repository } = await fixture()
    try {
      const first = createRevision(repository)
      const retryDuplicate = repository.createContentRevision({
        documentId: 'document-1',
        artifactId: 'artifact-2',
        contentHash: 'content-hash',
        mappingFingerprint: 'mapping-fingerprint',
        chunkerFingerprint: 'chunker-v1',
        contentRevisionId: 'retry-id',
        now
      })
      expect(retryDuplicate).toMatchObject({ contentRevisionId: first.contentRevisionId, artifactId: first.artifactId, state: 'building' })

      const second = chunk({ chunkId: 'chunk-2', ordinal: 1, sourceText: 'Second paragraph.' })
      expect(repository.replaceChunksAndActivate(first.contentRevisionId, [chunk(), second], now)).toMatchObject({ state: 'ready' })
      expect(repository.listChunks(first.contentRevisionId)).toEqual([chunk(), second])
      expect(repository.getDocumentKnowledge('document-1')).toMatchObject({
        localState: 'ready', localProgress: 100, activeContentRevisionId: first.contentRevisionId
      })

      expect(() => repository.replaceChunksAndActivate(first.contentRevisionId, [chunk({ ordinal: 1 })], now)).toThrowError(
        expect.objectContaining({ code: 'RAG_INVALID_CHUNK' })
      )
      expect(() => repository.replaceChunksAndActivate(first.contentRevisionId, [chunk()], now)).toThrowError(
        expect.objectContaining({ code: 'RAG_INVALID_CONTENT_TRANSITION' })
      )
      expect(repository.listChunks(first.contentRevisionId)).toHaveLength(2)

      const replacement = createRevision(repository, 'revision-2', 'content-hash-2')
      expect(() => repository.replaceChunksAndActivate(replacement.contentRevisionId, [chunk({ contentRevisionId: replacement.contentRevisionId })], now))
        .toThrowError(expect.objectContaining({ code: 'RAG_CHUNK_ID_CONFLICT' }))
      expect(repository.getContentRevision(replacement.contentRevisionId)).toMatchObject({ state: 'building' })
      repository.replaceChunksAndActivate(replacement.contentRevisionId, [chunk({ chunkId: 'chunk-3', contentRevisionId: replacement.contentRevisionId })], now)
      expect(repository.getContentRevision(first.contentRevisionId)).toMatchObject({ state: 'stale' })
      expect(repository.getDocumentKnowledge('document-1')?.activeContentRevisionId).toBe(replacement.contentRevisionId)
    } finally {
      database.close()
    }
  })

  it('enforces content revision transitions and marks the active index failed or stale', async () => {
    const { database, repository } = await fixture()
    try {
      const revision = createRevision(repository)
      repository.replaceChunksAndActivate(revision.contentRevisionId, [chunk()], now)
      expect(() => repository.transitionContentRevision({ contentRevisionId: revision.contentRevisionId, state: 'building', now })).toThrowError(
        expect.objectContaining({ code: 'RAG_INVALID_CONTENT_TRANSITION' })
      )
      repository.transitionContentRevision({ contentRevisionId: revision.contentRevisionId, state: 'stale', now })
      expect(repository.getDocumentKnowledge('document-1')).toMatchObject({ localState: 'stale', localProgress: 0 })
      repository.transitionContentRevision({
        contentRevisionId: revision.contentRevisionId,
        state: 'failed',
        error: { code: 'RAG_SOURCE_CHANGED', message: 'Source changed', retryable: true },
        now
      })
      expect(repository.getDocumentKnowledge('document-1')).toMatchObject({
        localState: 'failed', localError: { code: 'RAG_SOURCE_CHANGED', retryable: true }
      })
    } finally {
      database.close()
    }
  })

  it('removes document-scoped index rows with the document and passes FK checks', async () => {
    const { database, repository } = await fixture()
    try {
      const revision = createRevision(repository)
      repository.replaceChunksAndActivate(revision.contentRevisionId, [chunk()], now)
      database.connection.prepare('DELETE FROM documents WHERE id=?').run('document-1')
      expect(database.connection.prepare('SELECT COUNT(*) AS count FROM rag_documents WHERE document_id=?').get('document-1')).toEqual({ count: 0 })
      expect(database.connection.prepare('SELECT COUNT(*) AS count FROM rag_content_revisions WHERE document_id=?').get('document-1')).toEqual({ count: 0 })
      expect(database.connection.prepare('SELECT COUNT(*) AS count FROM rag_chunks').get()).toEqual({ count: 0 })
      expect(database.connection.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    } finally {
      database.close()
    }
  })
})
