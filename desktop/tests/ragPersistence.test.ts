import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RagChunk } from '@core/types'
import { V2Database } from '../src/utility/core/persistence/v2Database'
import { SqliteRagRepository, SqliteRagRepositoryError } from '../src/utility/core/persistence/sqliteRagRepository'
import { SqliteJobRepository } from '../src/utility/core/persistence/sqliteJobRepository'
import { RagDomainService } from '../src/utility/core/ragDomainService'

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
  database.connection.prepare(`
    INSERT INTO artifacts(id,document_id,kind,revision,relative_path,content_hash,metadata_json,created_at)
    VALUES(?,?,?,?,?,?,?,?)
  `).run('artifact-1', 'document-1', 'parsed_markdown', 1, 'paper.md', 'artifact-hash', '{}', now)
  database.connection.prepare(`
    INSERT INTO artifacts(id,document_id,kind,revision,relative_path,content_hash,metadata_json,created_at)
    VALUES(?,?,?,?,?,?,?,?)
  `).run('translation-artifact-1', 'document-1', 'translated_markdown', 1, 'paper.zh.md', 'translation-hash', '{}', now)
  database.connection.prepare(`
    INSERT INTO artifacts(id,document_id,kind,revision,relative_path,content_hash,metadata_json,created_at)
    VALUES(?,?,?,?,?,?,?,?)
  `).run('artifact-2', 'document-1', 'parsed_markdown', 2, 'paper-retry.md', 'artifact-retry-hash', '{}', now)
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

function revision(repository: SqliteRagRepository) {
  const created = repository.createContentRevision({
    documentId: 'document-1',
    artifactId: 'artifact-1',
    contentHash: 'content-hash',
    mappingFingerprint: 'mapping-fingerprint',
    chunkerFingerprint: 'chunker-v1',
    contentRevisionId: 'revision-1',
    now
  })
  repository.transitionContentRevision({ contentRevisionId: created.contentRevisionId, state: 'ready', now })
  repository.activateContentRevision(created.contentRevisionId, now)
  return created
}

describe('SqliteRagRepository', () => {
  it('creates an idempotent knowledge row and keeps local and semantic states independent', async () => {
    const { database, repository } = await fixture()
    try {
      expect(repository.ensureDocumentKnowledge('document-1', now)).toMatchObject({
        documentId: 'document-1',
        localState: 'unindexed',
        semanticState: 'disabled'
      })
      expect(repository.ensureDocumentKnowledge('document-1', now)).toEqual(repository.getDocumentKnowledge('document-1'))
      expect(repository.transitionLocalState({ documentId: 'document-1', state: 'queued', now })).toMatchObject({
        localState: 'queued', semanticState: 'disabled'
      })
      expect(repository.transitionLocalState({ documentId: 'document-1', state: 'queued', now })).toMatchObject({
        localState: 'queued', semanticState: 'disabled'
      })
      expect(repository.transitionSemanticState({ documentId: 'document-1', state: 'requires-consent', now })).toMatchObject({
        localState: 'queued', semanticState: 'requires-consent'
      })
      expect(repository.transitionSemanticState({ documentId: 'document-1', state: 'requires-credential', now })).toMatchObject({
        localState: 'queued', semanticState: 'requires-credential'
      })
      expect(() => repository.transitionLocalState({ documentId: 'document-1', state: 'ready', progress: 100, now })).toThrowError(
        expect.objectContaining({ code: 'RAG_INVALID_LOCAL_TRANSITION' })
      )
    } finally {
      database.close()
    }
  })

  it('deduplicates content revisions, persists canonical chunks, and keeps translation variants replaceable', async () => {
    const { database, repository } = await fixture()
    try {
      const first = revision(repository)
      const duplicate = repository.createContentRevision({
        documentId: 'document-1',
        artifactId: 'artifact-1',
        contentHash: 'content-hash',
        mappingFingerprint: 'mapping-fingerprint',
        chunkerFingerprint: 'chunker-v1',
        contentRevisionId: 'another-id',
        now
      })
      expect(duplicate).toMatchObject({
        contentRevisionId: first.contentRevisionId,
        documentId: first.documentId,
        state: 'ready'
      })
      const retryDuplicate = repository.createContentRevision({
        documentId: 'document-1',
        artifactId: 'artifact-2',
        contentHash: 'content-hash',
        mappingFingerprint: 'mapping-fingerprint',
        chunkerFingerprint: 'chunker-v1',
        contentRevisionId: 'retry-id',
        now
      })
      expect(retryDuplicate.contentRevisionId).toBe(first.contentRevisionId)
      expect(retryDuplicate.artifactId).toBe(first.artifactId)
      const storedChunk = repository.upsertChunk(chunk(), now)
      expect(storedChunk).toEqual(chunk())
      expect(repository.upsertChunk({ ...chunk(), sourceText: 'Updated source paragraph.' }, now).sourceText).toBe('Updated source paragraph.')
      expect(repository.listChunks('revision-1')).toHaveLength(1)
      expect(repository.upsertChunkVariant({
        chunkId: 'chunk-1',
        translationArtifactId: 'translation-artifact-1',
        translationGeneration: 1,
        status: 'ready',
        translatedText: '译文',
        translatedHash: 'translated-hash',
        provider: 'qwen',
        model: 'qwen-test',
        now
      })).toMatchObject({ status: 'ready', translatedText: '译文' })
      expect(repository.upsertChunkVariant({
        chunkId: 'chunk-1',
        translationArtifactId: 'translation-artifact-1',
        translationGeneration: 1,
        status: 'ready',
        translatedText: '替换后的译文',
        now
      })).toMatchObject({ translatedText: '替换后的译文' })
      expect(repository.listChunkVariants('chunk-1')).toHaveLength(1)
      expect(() => repository.upsertChunk({ ...chunk({ chunkId: 'chunk-1', contentRevisionId: 'other-revision' }) }, now)).toThrowError(
        expect.objectContaining({ code: 'RAG_CONTENT_REVISION_NOT_FOUND' })
      )
    } finally {
      database.close()
    }
  })

  it('persists exact vector metadata, cache LRU data, and reports embedding failures without changing local readiness', async () => {
    const { database, repository } = await fixture()
    try {
      revision(repository)
      repository.upsertChunk(chunk(), now)
      repository.upsertChunkVariant({
        chunkId: 'chunk-1',
        translationArtifactId: 'translation-artifact-1',
        translationGeneration: 1,
        status: 'ready',
        translatedText: '译文',
        now
      })
      repository.upsertProfile({
        profileId: 'embedding-default',
        capability: 'embedding',
        provider: 'test-provider',
        model: 'test-model',
        profileFingerprint: 'profile-fingerprint',
        dimensions: 2,
        metric: 'cosine',
        credentialRef: 'vault-account-1',
        now
      })
      const vectorIndex = repository.upsertVectorIndex({
        vectorIndexId: 'vector-index-1',
        documentId: 'document-1',
        contentRevisionId: 'revision-1',
        profileId: 'embedding-default',
        dimensions: 2,
        metric: 'cosine',
        state: 'building',
        now
      })
      expect(repository.transitionVectorIndex({ vectorIndexId: vectorIndex.vectorIndexId, state: 'ready', now })).toMatchObject({ state: 'ready' })
      const embedding = new Uint8Array(new Float32Array([0.5, -0.25]).buffer)
      expect(repository.upsertEmbedding({ vectorIndexId: 'vector-index-1', chunkId: 'chunk-1', dimensions: 2, embedding, now })).toMatchObject({
        vectorIndexId: 'vector-index-1', contentRevisionId: 'revision-1', chunkId: 'chunk-1', dimensions: 2
      })
      expect(() => repository.upsertEmbedding({ vectorIndexId: 'vector-index-1', chunkId: 'chunk-1', dimensions: 3, embedding, now })).toThrowError(
        expect.objectContaining({ code: 'RAG_INVALID_VECTOR' })
      )
      expect(repository.upsertEmbeddingCache({ cacheKey: 'cache-1', profileId: 'embedding-default', contentHash: 'chunk-hash', dimensions: 2, embedding, now })).toMatchObject({ byteSize: 8 })
      expect(repository.touchEmbeddingCache('cache-1', '2026-01-01T00:01:00.000Z').lastAccessedAt).toBe('2026-01-01T00:01:00.000Z')
      expect(repository.activateVectorIndex('vector-index-1', now)).toMatchObject({
        localState: 'ready', semanticState: 'ready', semanticProfileId: 'embedding-default'
      })
      const failed = repository.transitionSemanticState({
        documentId: 'document-1',
        state: 'stale',
        now
      })
      expect(failed).toMatchObject({ localState: 'ready', semanticState: 'stale' })
      const embeddingFailed = repository.transitionSemanticState({
        documentId: 'document-1',
        state: 'failed',
        error: { code: 'PROVIDER_UNAVAILABLE', message: 'Embedding provider unavailable', retryable: true },
        now
      })
      expect(embeddingFailed).toMatchObject({
        localState: 'ready',
        semanticState: 'failed',
        semanticError: { code: 'PROVIDER_UNAVAILABLE', retryable: true }
      })
      expect(() => repository.upsertProfile({
        profileId: 'plain-secret',
        capability: 'embedding',
        provider: 'test-provider',
        model: 'test-model',
        profileFingerprint: 'secret-fingerprint',
        credentialRef: 'api-key=sk-live-secret',
        now
      })).toThrowError(expect.objectContaining({ code: 'RAG_PLAINTEXT_SECRET' }))
    } finally {
      database.close()
    }
  })

  it('deletes document-scoped RAG rows, preserves the external-delete tombstone, and passes FK checks', async () => {
    const { database, repository } = await fixture()
    try {
      revision(repository)
      repository.upsertChunk(chunk(), now)
      repository.upsertProfile({
        profileId: 'embedding-default',
        capability: 'embedding',
        provider: 'test-provider',
        model: 'test-model',
        profileFingerprint: 'profile-fingerprint',
        dimensions: 2,
        now
      })
      const vectorIndex = repository.upsertVectorIndex({
        vectorIndexId: 'vector-index-1',
        documentId: 'document-1',
        contentRevisionId: 'revision-1',
        profileId: 'embedding-default',
        dimensions: 2,
        metric: 'cosine',
        now
      })
      repository.transitionVectorIndex({ vectorIndexId: vectorIndex.vectorIndexId, state: 'building', now })
      repository.transitionVectorIndex({ vectorIndexId: vectorIndex.vectorIndexId, state: 'ready', now })
      const embedding = new Uint8Array(new Float32Array([0.5, 0.25]).buffer)
      repository.upsertEmbedding({ vectorIndexId: 'vector-index-1', chunkId: 'chunk-1', dimensions: 2, embedding, now })
      repository.activateVectorIndex('vector-index-1', now)
      repository.queueDocumentDeletion('document-1', now)
      expect(repository.getDeletionTombstone('document-1')).toMatchObject({ state: 'queued' })

      // This is the caller's document deletion boundary.  The tombstone has
      // no document FK, while every ordinary RAG row is document-scoped.
      database.connection.prepare('DELETE FROM documents WHERE id=?').run('document-1')
      expect(database.connection.prepare('SELECT COUNT(*) AS count FROM rag_documents WHERE document_id=?').get('document-1')).toEqual({ count: 0 })
      expect(database.connection.prepare('SELECT COUNT(*) AS count FROM rag_content_revisions WHERE document_id=?').get('document-1')).toEqual({ count: 0 })
      expect(database.connection.prepare('SELECT COUNT(*) AS count FROM rag_chunks').get()).toEqual({ count: 0 })
      expect(database.connection.prepare('SELECT COUNT(*) AS count FROM rag_chunk_variants').get()).toEqual({ count: 0 })
      expect(database.connection.prepare('SELECT COUNT(*) AS count FROM rag_vector_indexes WHERE document_id=?').get('document-1')).toEqual({ count: 0 })
      expect(database.connection.prepare('SELECT COUNT(*) AS count FROM rag_embeddings').get()).toEqual({ count: 0 })
      expect(database.connection.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      expect(repository.finalizeDocumentDeletion('document-1', now)).toMatchObject({ state: 'succeeded' })
      expect(repository.getProfile('embedding-default')).not.toBeNull()
    } finally {
      database.close()
    }
  })

  it('rejects illegal state transitions and rolls back a failed mutation', async () => {
    const { database, repository } = await fixture()
    try {
      repository.ensureDocumentKnowledge('document-1', now)
      expect(() => repository.transitionLocalState({ documentId: 'document-1', state: 'ready', progress: 100, now })).toThrowError(
        expect.objectContaining({ code: 'RAG_INVALID_LOCAL_TRANSITION' })
      )
      expect(repository.getDocumentKnowledge('document-1')).toMatchObject({ localState: 'unindexed', semanticState: 'disabled' })
      expect(() => repository.upsertProfile({
        profileId: 'bad-profile',
        capability: 'embedding',
        provider: 'test-provider',
        model: 'test-model',
        profileFingerprint: 'bad-fingerprint',
        metadata: { circular: BigInt(1) },
        now
      })).toThrowError(SqliteRagRepositoryError)
      expect(repository.getProfile('bad-profile')).toBeNull()
    } finally {
      database.close()
    }
  })

  it('enforces semantic prerequisites, queues one embed job, and keeps local readiness on semantic failure', async () => {
    const { database, repository } = await fixture()
    try {
      const jobs = new SqliteJobRepository(database)
      const service = new RagDomainService(database, repository, jobs)

      expect(() => service.ensureEmbeddingJob({ documentId: 'document-1', profileId: 'embedding-default', now }))
        .toThrowError(expect.objectContaining({ code: 'RAG_CONTENT_NOT_READY' }))
      expect(jobs.list({ documentId: 'document-1', kind: 'rag-embed' })).toHaveLength(0)

      revision(repository)
      expect(() => service.ensureEmbeddingJob({ documentId: 'document-1', profileId: 'embedding-default', now }))
        .toThrowError(expect.objectContaining({ code: 'SEMANTIC_CONSENT_REQUIRED' }))
      expect(jobs.list({ documentId: 'document-1', kind: 'rag-embed' })).toHaveLength(0)

      service.setSemanticConsent('document-1', true, now)
      expect(() => service.ensureEmbeddingJob({ documentId: 'document-1', profileId: 'missing-profile', now }))
        .toThrowError(expect.objectContaining({ code: 'RAG_PROFILE_NOT_FOUND' }))
      expect(jobs.list({ documentId: 'document-1', kind: 'rag-embed' })).toHaveLength(0)

      repository.upsertProfile({
        profileId: 'embedding-default',
        capability: 'embedding',
        provider: 'test-provider',
        model: 'test-model',
        profileFingerprint: 'profile-fingerprint',
        dimensions: null,
        credentialRef: null,
        now
      })
      expect(() => service.ensureEmbeddingJob({ documentId: 'document-1', profileId: 'embedding-default', now }))
        .toThrowError(expect.objectContaining({ code: 'EMBEDDING_CREDENTIALS_REQUIRED' }))
      expect(jobs.list({ documentId: 'document-1', kind: 'rag-embed' })).toHaveLength(0)

      repository.upsertProfile({
        profileId: 'embedding-default',
        capability: 'embedding',
        provider: 'test-provider',
        model: 'test-model',
        profileFingerprint: 'profile-fingerprint',
        dimensions: 2,
        credentialRef: 'vault-account-1',
        now
      })
      const first = service.ensureEmbeddingJob({ documentId: 'document-1', profileId: 'embedding-default', now })
      const second = service.ensureEmbeddingJob({ documentId: 'document-1', profileId: 'embedding-default', now })
      expect(first).toEqual(second)
      expect(first).toMatchObject({ jobKind: 'rag-embed', jobStatus: 'queued', vectorIndexState: 'queued', semanticState: 'queued' })
      expect(jobs.list({ documentId: 'document-1', kind: 'rag-embed' })).toHaveLength(1)
      expect(repository.listVectorIndexes('document-1', 'revision-1')).toHaveLength(1)

      expect(service.setSemanticConsent('document-1', false, now)).toMatchObject({ semanticConsent: false, semanticState: 'requires-consent' })
      expect(jobs.list({ documentId: 'document-1', kind: 'rag-embed' })[0]).toMatchObject({ status: 'cancelled' })
      expect(service.setSemanticConsent('document-1', true, now)).toMatchObject({ semanticConsent: true, semanticState: 'requires-credential' })
      expect(service.ensureEmbeddingJob({ documentId: 'document-1', profileId: 'embedding-default', now })).toMatchObject({
        jobKind: 'rag-embed', jobStatus: 'queued'
      })

      const claimed = jobs.claimBatch({
        now: '2026-01-01T00:00:04.000Z',
        leaseOwner: 'embedding-runner',
        leaseExpiresAt: '2026-01-01T00:01:00.000Z',
        kind: 'rag-embed'
      })[0]!
      jobs.complete({
        jobId: claimed.id,
        leaseOwner: 'embedding-runner',
        status: 'succeeded',
        progress: 100,
        now: '2026-01-01T00:00:05.000Z'
      })
      repository.transitionVectorIndex({ vectorIndexId: first.vectorIndexId, state: 'building', now })
      repository.transitionVectorIndex({ vectorIndexId: first.vectorIndexId, state: 'ready', now })
      repository.activateVectorIndex(first.vectorIndexId, now)
      expect(service.ensureEmbeddingJob({ documentId: 'document-1', profileId: 'embedding-default', now })).toMatchObject({
        jobKind: 'rag-embed', jobStatus: 'succeeded', vectorIndexState: 'ready', semanticState: 'ready'
      })

      repository.transitionSemanticState({
        documentId: 'document-1',
        state: 'stale',
        now
      })
      repository.transitionSemanticState({
        documentId: 'document-1',
        state: 'failed',
        error: { code: 'PROVIDER_UNAVAILABLE', message: 'provider failed', retryable: true },
        now
      })
      expect(repository.getDocumentKnowledge('document-1')).toMatchObject({ localState: 'ready', semanticState: 'failed' })
    } finally {
      database.close()
    }
  })
})
