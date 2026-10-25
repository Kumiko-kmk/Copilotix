import { randomUUID } from 'node:crypto'
import type { StatementSync } from 'node:sqlite'
import type { RagChunk } from '@core/types'
import { V2Database } from '@platform/database/utility/v2Database'
import {
  CONTENT_TRANSITIONS,
  SqliteRagRepositoryError,
  fromKnowledgeRow,
  fromContentRevisionRow,
  fromChunkRow,
  mergeKnowledge,
  validateKnowledge,
  normalizeChunk,
  normalizeError,
  requireError,
  validateIdentifier,
  validateText,
  validateTimestamp,
  validateInteger,
  type RagDocumentKnowledge,
  type RagDocumentKnowledgeUpsert,
  type RagContentRevisionRecord,
  type RagContentRevisionCreateInput,
  type RagContentRevisionTransitionInput,
  type KnowledgeRow,
  type ContentRevisionRow,
  type ChunkRow
} from './ragRecords'

export { SqliteRagRepositoryError } from './ragRecords'
export type { RagContentRevisionState, RagPersistedError, RagErrorInput, RagDocumentKnowledge, RagDocumentKnowledgeUpsert, RagContentRevisionRecord, RagContentRevisionCreateInput, RagContentRevisionTransitionInput } from './ragRecords'

/**
 * Utility-owned persistence for the single-paper chat index: per-document
 * index state, content revisions and chunks.  It intentionally does not call
 * a chunker or runner.  The semantic/vector tables from the abandoned RAG
 * plan remain in the schema for migration compatibility but have no API.
 * Each mutating operation is one durable transaction so a restart can
 * observe either the old or the new state.
 */
export class SqliteRagRepository {
  private readonly connection: V2Database['connection']
  private readonly selectKnowledge: StatementSync
  private readonly selectRevision: StatementSync
  private readonly selectChunk: StatementSync

  constructor(private readonly database: V2Database) {
    this.connection = database.connection
    this.selectKnowledge = this.connection.prepare('SELECT * FROM rag_documents WHERE document_id=?')
    this.selectRevision = this.connection.prepare('SELECT * FROM rag_content_revisions WHERE content_revision_id=?')
    this.selectChunk = this.connection.prepare('SELECT * FROM rag_chunks WHERE chunk_id=?')
  }

  getDocumentKnowledge(documentId: string): RagDocumentKnowledge | null {
    const id = validateIdentifier(documentId, 'document id')
    const row = this.selectKnowledge.get(id) as KnowledgeRow | undefined
    return row ? fromKnowledgeRow(row) : null
  }

  upsertDocumentKnowledge(input: RagDocumentKnowledgeUpsert): RagDocumentKnowledge {
    const documentId = validateIdentifier(input.documentId, 'document id')
    const now = validateTimestamp(input.now ?? new Date().toISOString(), 'knowledge time')
    return this.database.transaction(() => {
      this.ensureDocumentKnowledgeUnsafe(documentId, now)
      const existing = this.getKnowledgeUnsafe(documentId)!
      const next = mergeKnowledge(existing, input, now)
      validateKnowledge(next)
      this.connection.prepare(`
        UPDATE rag_documents SET
          local_state=?, local_progress=?, local_error_code=?, local_error_message=?,
          local_error_retryable=?, local_error_retry_after_ms=?, active_content_revision_id=?,
          semantic_consent=?,
          semantic_state=?, semantic_progress=?, semantic_error_code=?, semantic_error_message=?,
          semantic_error_retryable=?, semantic_error_retry_after_ms=?, semantic_content_revision_id=?,
          active_vector_index_id=?, semantic_profile_id=?, updated_at=?
        WHERE document_id=?
      `).run(
        next.localState,
        next.localProgress,
        next.localError?.code ?? null,
        next.localError?.message ?? null,
        next.localError ? (next.localError.retryable ? 1 : 0) : null,
        next.localError?.retryAfterMs ?? null,
        next.activeContentRevisionId,
        next.semanticConsent ? 1 : 0,
        next.semanticState,
        next.semanticProgress,
        next.semanticError?.code ?? null,
        next.semanticError?.message ?? null,
        next.semanticError ? (next.semanticError.retryable ? 1 : 0) : null,
        next.semanticError?.retryAfterMs ?? null,
        next.semanticContentRevisionId,
        next.activeVectorIndexId,
        next.semanticProfileId,
        now,
        documentId
      )
      return this.getKnowledgeUnsafe(documentId)!
    })
  }

  ensureDocumentKnowledge(documentId: string, now?: string): RagDocumentKnowledge {
    return this.upsertDocumentKnowledge({ documentId, now })
  }

  createContentRevision(input: RagContentRevisionCreateInput): RagContentRevisionRecord {
    const documentId = validateIdentifier(input.documentId, 'document id')
    const artifactId = validateIdentifier(input.artifactId, 'artifact id')
    const contentHash = validateText(input.contentHash, 'content hash', 512)
    const mappingFingerprint = validateText(input.mappingFingerprint, 'mapping fingerprint', 512)
    const chunkerFingerprint = validateText(input.chunkerFingerprint, 'chunker fingerprint', 512)
    const lexicalGeneration = validateInteger(input.lexicalGeneration ?? 0, 0, 2_147_483_647, 'lexical generation')
    const contentRevisionId = validateIdentifier(input.contentRevisionId ?? input.id ?? randomUUID(), 'content revision id', 256)
    const now = validateTimestamp(input.now ?? new Date().toISOString(), 'content revision time')
    return this.database.transaction(() => {
      this.ensureDocumentKnowledgeUnsafe(documentId, now)
      const deduplicated = this.connection.prepare(`
        SELECT * FROM rag_content_revisions
        WHERE document_id=? AND content_hash=?
          AND mapping_fingerprint=? AND chunker_fingerprint=?
      `).get(documentId, contentHash, mappingFingerprint, chunkerFingerprint) as ContentRevisionRow | undefined
      if (deduplicated) return fromContentRevisionRow(deduplicated)
      try {
        this.connection.prepare(`
          INSERT INTO rag_content_revisions(
            content_revision_id, document_id, artifact_id, content_hash,
            mapping_fingerprint, chunker_fingerprint, lexical_generation,
            state, error_code, error_message, created_at, updated_at
          ) VALUES(?,?,?,?,?,?,?,'building',NULL,NULL,?,?)
        `).run(contentRevisionId, documentId, artifactId, contentHash, mappingFingerprint, chunkerFingerprint, lexicalGeneration, now, now)
      } catch {
        throw new SqliteRagRepositoryError('RAG_CONTENT_REVISION_EXISTS', 'Content revision identity is already used', false)
      }
      return this.getRevisionUnsafe(contentRevisionId)!
    })
  }

  getContentRevision(contentRevisionId: string): RagContentRevisionRecord | null {
    const row = this.selectRevision.get(validateIdentifier(contentRevisionId, 'content revision id')) as ContentRevisionRow | undefined
    return row ? fromContentRevisionRow(row) : null
  }

  transitionContentRevision(input: RagContentRevisionTransitionInput): RagContentRevisionRecord {
    const id = validateIdentifier(input.contentRevisionId, 'content revision id')
    const now = validateTimestamp(input.now ?? new Date().toISOString(), 'content revision transition time')
    const error = normalizeError(input.error, 'content revision error')
    const lexicalGeneration = input.lexicalGeneration === undefined
      ? undefined
      : validateInteger(input.lexicalGeneration, 0, 2_147_483_647, 'lexical generation')
    return this.database.transaction(() => {
      const current = this.requireRevisionUnsafe(id)
      if (current.state !== input.state && !CONTENT_TRANSITIONS[current.state].includes(input.state)) {
        throw new SqliteRagRepositoryError('RAG_INVALID_CONTENT_TRANSITION', `Cannot move content revision from ${current.state} to ${input.state}`)
      }
      const finalError = input.state === 'failed' ? requireError(error ?? fromContentRevisionRow(current).error, 'content revision error') : null
      this.connection.prepare(`
        UPDATE rag_content_revisions SET state=?, error_code=?, error_message=?, lexical_generation=?, updated_at=?
        WHERE content_revision_id=?
      `).run(
        input.state,
        finalError?.code ?? null,
        finalError?.message ?? null,
        lexicalGeneration ?? current.lexical_generation,
        now,
        id
      )
      const knowledge = this.getKnowledgeUnsafe(current.document_id)
      if (knowledge?.activeContentRevisionId === id && input.state === 'stale') {
        this.connection.prepare(`
          UPDATE rag_documents SET local_state='stale', local_progress=0, local_error_code=NULL,
            local_error_message=NULL, local_error_retryable=NULL, local_error_retry_after_ms=NULL, updated_at=?
          WHERE document_id=? AND local_state='ready'
        `).run(now, current.document_id)
      } else if (knowledge?.activeContentRevisionId === id && input.state === 'failed') {
        this.connection.prepare(`
          UPDATE rag_documents SET local_state='failed', local_progress=0,
            local_error_code=?, local_error_message=?, local_error_retryable=?, local_error_retry_after_ms=?, updated_at=?
          WHERE document_id=?
        `).run(finalError!.code, finalError!.message, finalError!.retryable ? 1 : 0, finalError!.retryAfterMs, now, current.document_id)
      }
      return this.getContentRevision(id)!
    })
  }

  /** Replace one building revision atomically, then make it the active local index. */
  replaceChunksAndActivate(contentRevisionId: string, chunks: readonly RagChunk[], now?: string): RagContentRevisionRecord {
    const revisionId = validateIdentifier(contentRevisionId, 'content revision id')
    const timestamp = validateTimestamp(now ?? new Date().toISOString(), 'chunk publication time')
    const normalized = chunks.map((chunk) => normalizeChunk(chunk))
    const seen = new Set<string>()
    for (const [ordinal, chunk] of normalized.entries()) {
      if (chunk.contentRevisionId !== revisionId || chunk.ordinal !== ordinal || seen.has(chunk.chunkId)) throw new SqliteRagRepositoryError('RAG_INVALID_CHUNK', 'Chunk batch must have contiguous ordinals for one revision')
      seen.add(chunk.chunkId)
    }
    return this.database.transaction(() => {
      const revision = this.requireRevisionUnsafe(revisionId)
      if (revision.state !== 'building' && revision.state !== 'stale' && revision.state !== 'failed') {
        throw new SqliteRagRepositoryError('RAG_INVALID_CONTENT_TRANSITION', 'Only a buildable revision can be published')
      }
      this.connection.prepare('DELETE FROM rag_chunks WHERE content_revision_id=?').run(revisionId)
      for (const chunk of normalized) this.upsertChunkUnsafe(chunk, timestamp)
      this.connection.prepare(`
        UPDATE rag_content_revisions SET state='ready', error_code=NULL, error_message=NULL, updated_at=?
        WHERE content_revision_id=?
      `).run(timestamp, revisionId)
      const previousActive = this.getKnowledgeUnsafe(revision.document_id)?.activeContentRevisionId
      if (previousActive && previousActive !== revisionId) {
        this.connection.prepare(`
          UPDATE rag_content_revisions SET state='stale', error_code=NULL, error_message=NULL, updated_at=?
          WHERE content_revision_id=? AND state='ready'
        `).run(timestamp, previousActive)
      }
      this.connection.prepare(`
        UPDATE rag_documents SET local_state='ready', local_progress=100,
          local_error_code=NULL, local_error_message=NULL, local_error_retryable=NULL,
          local_error_retry_after_ms=NULL, active_content_revision_id=?, updated_at=?
        WHERE document_id=?
      `).run(revisionId, timestamp, revision.document_id)
      const knowledge = this.getKnowledgeUnsafe(revision.document_id)
      if (knowledge?.semanticState === 'ready' || knowledge?.semanticState === 'indexing') {
        this.connection.prepare(`
          UPDATE rag_documents SET semantic_state='stale', semantic_progress=0,
            semantic_error_code=NULL, semantic_error_message=NULL, semantic_error_retryable=NULL,
            semantic_error_retry_after_ms=NULL, semantic_content_revision_id=NULL,
            active_vector_index_id=NULL, semantic_profile_id=NULL, updated_at=? WHERE document_id=?
        `).run(timestamp, revision.document_id)
      }
      return this.getContentRevision(revisionId)!
    })
  }

  private upsertChunkUnsafe(normalized: RagChunk, timestamp: string): void {
    const revision = this.requireRevisionUnsafe(normalized.contentRevisionId)
    if (revision.document_id.length === 0) throw new SqliteRagRepositoryError('RAG_INVALID_CHUNK', 'Chunk revision is invalid')
    const existing = this.selectChunk.get(normalized.chunkId) as ChunkRow | undefined
    if (existing && existing.content_revision_id !== normalized.contentRevisionId) {
      throw new SqliteRagRepositoryError('RAG_CHUNK_ID_CONFLICT', 'Chunk ID belongs to another content revision')
    }
    this.connection.prepare(`
      INSERT INTO rag_chunks(
        chunk_id, content_revision_id, ordinal, content_hash, source_text,
        section_path_json, mapping_ids_json, page_start, page_end,
        source_start_offset, source_end_offset, offset_unit, token_count,
        content_type, mapping_confidence, created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(chunk_id) DO UPDATE SET
        ordinal=excluded.ordinal, content_hash=excluded.content_hash, source_text=excluded.source_text,
        section_path_json=excluded.section_path_json, mapping_ids_json=excluded.mapping_ids_json,
        page_start=excluded.page_start, page_end=excluded.page_end,
        source_start_offset=excluded.source_start_offset, source_end_offset=excluded.source_end_offset,
        offset_unit=excluded.offset_unit, token_count=excluded.token_count,
        content_type=excluded.content_type, mapping_confidence=excluded.mapping_confidence,
        updated_at=excluded.updated_at
    `).run(
      normalized.chunkId, normalized.contentRevisionId, normalized.ordinal, normalized.contentHash, normalized.sourceText,
      JSON.stringify(normalized.sectionPath), JSON.stringify(normalized.mappingIds), normalized.pageStart, normalized.pageEnd,
      normalized.sourceStartOffset, normalized.sourceEndOffset, normalized.offsetUnit, normalized.tokenCount,
      normalized.contentType, normalized.mappingConfidence, existing?.created_at ?? timestamp, timestamp
    )
  }

  listChunks(contentRevisionId: string): RagChunk[] {
    const id = validateIdentifier(contentRevisionId, 'content revision id')
    return (this.connection.prepare('SELECT * FROM rag_chunks WHERE content_revision_id=? ORDER BY ordinal ASC, chunk_id ASC').all(id) as unknown as ChunkRow[]).map(fromChunkRow)
  }

  private getKnowledgeUnsafe(documentId: string): RagDocumentKnowledge | null {
    const row = this.selectKnowledge.get(documentId) as KnowledgeRow | undefined
    return row ? fromKnowledgeRow(row) : null
  }

  private ensureDocumentKnowledgeUnsafe(documentId: string, now: string): void {
    const document = this.connection.prepare('SELECT 1 AS present FROM documents WHERE id=?').get(documentId) as { present: number } | undefined
    if (!document) throw new SqliteRagRepositoryError('DOCUMENT_NOT_FOUND', 'Document does not exist')
    this.connection.prepare(`
      INSERT INTO rag_documents(document_id, updated_at) VALUES(?,?) ON CONFLICT(document_id) DO NOTHING
    `).run(documentId, now)
  }

  private getRevisionUnsafe(contentRevisionId: string): RagContentRevisionRecord | null {
    const row = this.selectRevision.get(contentRevisionId) as ContentRevisionRow | undefined
    return row ? fromContentRevisionRow(row) : null
  }

  private requireRevisionUnsafe(contentRevisionId: string): ContentRevisionRow {
    const row = this.selectRevision.get(contentRevisionId) as ContentRevisionRow | undefined
    if (!row) throw new SqliteRagRepositoryError('RAG_CONTENT_REVISION_NOT_FOUND', 'Content revision does not exist')
    return row
  }
}
