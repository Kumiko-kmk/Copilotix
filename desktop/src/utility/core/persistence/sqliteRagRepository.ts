import { randomUUID } from 'node:crypto'
import type { StatementSync } from 'node:sqlite'
import type {
  RagChunk,
  RagChunkContentType,
  RagMappingConfidence
} from '@core/types'
import type {
  LocalIndexState,
  SemanticIndexState
} from '@shared/ragSchemas'
import { V2Database } from '@platform/database/utility/v2Database'

export type RagContentRevisionState = 'building' | 'ready' | 'stale' | 'failed'

export interface RagPersistedError {
  code: string
  message: string
  retryable: boolean
  retryAfterMs: number | null
}

export type RagErrorInput = {
  code: string
  message: string
  retryable?: boolean
  retryAfterMs?: number | null
} | null

export interface RagDocumentKnowledge {
  documentId: string
  localState: LocalIndexState
  localProgress: number
  localError: RagPersistedError | null
  activeContentRevisionId: string | null
  /** Persisted user authorization; provider credentials never imply consent. */
  semanticConsent: boolean
  semanticState: SemanticIndexState
  semanticProgress: number
  semanticError: RagPersistedError | null
  semanticContentRevisionId: string | null
  activeVectorIndexId: string | null
  semanticProfileId: string | null
  updatedAt: string
}

export interface RagDocumentKnowledgeUpsert {
  documentId: string
  localState?: LocalIndexState
  localProgress?: number
  localError?: RagErrorInput
  activeContentRevisionId?: string | null
  semanticConsent?: boolean
  semanticState?: SemanticIndexState
  semanticProgress?: number
  semanticError?: RagErrorInput
  semanticContentRevisionId?: string | null
  activeVectorIndexId?: string | null
  semanticProfileId?: string | null
  now?: string
}

export interface RagContentRevisionRecord {
  contentRevisionId: string
  documentId: string
  artifactId: string
  contentHash: string
  mappingFingerprint: string
  chunkerFingerprint: string
  lexicalGeneration: number
  state: RagContentRevisionState
  error: RagPersistedError | null
  createdAt: string
  updatedAt: string
}

export interface RagContentRevisionCreateInput {
  documentId: string
  artifactId: string
  contentHash: string
  mappingFingerprint: string
  chunkerFingerprint: string
  lexicalGeneration?: number
  contentRevisionId?: string
  /** Alias useful to callers that use the database column name. */
  id?: string
  now?: string
}

export interface RagContentRevisionTransitionInput {
  contentRevisionId: string
  state: RagContentRevisionState
  error?: RagErrorInput
  lexicalGeneration?: number
  now?: string
}

type KnowledgeRow = {
  document_id: string
  local_state: LocalIndexState
  local_progress: number
  local_error_code: string | null
  local_error_message: string | null
  local_error_retryable: number | null
  local_error_retry_after_ms: number | null
  active_content_revision_id: string | null
  semantic_state: SemanticIndexState
  semantic_progress: number
  semantic_error_code: string | null
  semantic_error_message: string | null
  semantic_error_retryable: number | null
  semantic_error_retry_after_ms: number | null
  semantic_content_revision_id: string | null
  active_vector_index_id: string | null
  semantic_profile_id: string | null
  semantic_consent: number
  updated_at: string
}

type ContentRevisionRow = {
  content_revision_id: string
  document_id: string
  artifact_id: string
  content_hash: string
  mapping_fingerprint: string
  chunker_fingerprint: string
  lexical_generation: number
  state: RagContentRevisionState
  error_code: string | null
  error_message: string | null
  created_at: string
  updated_at: string
}

type ChunkRow = {
  chunk_id: string
  content_revision_id: string
  ordinal: number
  content_hash: string
  source_text: string
  section_path_json: string
  mapping_ids_json: string
  page_start: number | null
  page_end: number | null
  source_start_offset: number | null
  source_end_offset: number | null
  offset_unit: 'utf16'
  token_count: number
  content_type: RagChunkContentType
  mapping_confidence: RagMappingConfidence
  created_at: string
  updated_at: string
}

const CONTENT_TRANSITIONS: Readonly<Record<RagContentRevisionState, readonly RagContentRevisionState[]>> = Object.freeze({
  building: ['ready', 'stale', 'failed'],
  ready: ['stale'],
  stale: ['building', 'failed'],
  failed: ['building']
})

const LOCAL_STATES_REQUIRING_NO_ACTIVE = new Set<LocalIndexState>(['unindexed'])
const SEMANTIC_STATES_REQUIRING_NO_ACTIVE = new Set<SemanticIndexState>(['disabled', 'requires-consent', 'requires-credential'])

export class SqliteRagRepositoryError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message)
    this.name = 'SqliteRagRepositoryError'
  }
}

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

function fromKnowledgeRow(row: KnowledgeRow): RagDocumentKnowledge {
  return {
    documentId: row.document_id,
    localState: row.local_state,
    localProgress: row.local_progress,
    localError: errorFromColumns(row.local_error_code, row.local_error_message, row.local_error_retryable, row.local_error_retry_after_ms),
    activeContentRevisionId: row.active_content_revision_id,
    semanticConsent: row.semantic_consent === 1,
    semanticState: row.semantic_state,
    semanticProgress: row.semantic_progress,
    semanticError: errorFromColumns(row.semantic_error_code, row.semantic_error_message, row.semantic_error_retryable, row.semantic_error_retry_after_ms),
    semanticContentRevisionId: row.semantic_content_revision_id,
    activeVectorIndexId: row.active_vector_index_id,
    semanticProfileId: row.semantic_profile_id,
    updatedAt: row.updated_at
  }
}

function fromContentRevisionRow(row: ContentRevisionRow): RagContentRevisionRecord {
  return {
    contentRevisionId: row.content_revision_id,
    documentId: row.document_id,
    artifactId: row.artifact_id,
    contentHash: row.content_hash,
    mappingFingerprint: row.mapping_fingerprint,
    chunkerFingerprint: row.chunker_fingerprint,
    lexicalGeneration: row.lexical_generation,
    state: row.state,
    error: errorFromColumns(row.error_code, row.error_message, null, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function fromChunkRow(row: ChunkRow): RagChunk {
  return {
    chunkId: row.chunk_id,
    contentRevisionId: row.content_revision_id,
    ordinal: row.ordinal,
    contentHash: row.content_hash,
    sourceText: row.source_text,
    sectionPath: parseStringArray(row.section_path_json, 'section path'),
    mappingIds: parseStringArray(row.mapping_ids_json, 'mapping ids'),
    pageStart: row.page_start,
    pageEnd: row.page_end,
    sourceStartOffset: row.source_start_offset,
    sourceEndOffset: row.source_end_offset,
    offsetUnit: row.offset_unit,
    tokenCount: row.token_count,
    contentType: row.content_type,
    mappingConfidence: row.mapping_confidence
  }
}

function mergeKnowledge(current: RagDocumentKnowledge, input: RagDocumentKnowledgeUpsert, now: string): RagDocumentKnowledge {
  const localState = input.localState ?? current.localState
  const semanticConsent = input.semanticConsent ?? current.semanticConsent
  const semanticState = input.semanticState ?? current.semanticState
  const localError = input.localError !== undefined
    ? normalizeError(input.localError, 'local index error')
    : localState === 'failed' ? current.localError : null
  const semanticError = input.semanticError !== undefined
    ? normalizeError(input.semanticError, 'semantic index error')
    : semanticState === 'failed' ? current.semanticError : null
  const activeContentRevisionId = LOCAL_STATES_REQUIRING_NO_ACTIVE.has(localState)
    ? null
    : input.activeContentRevisionId === undefined ? current.activeContentRevisionId : input.activeContentRevisionId
  const semanticContentRevisionId = SEMANTIC_STATES_REQUIRING_NO_ACTIVE.has(semanticState)
    ? null
    : input.semanticContentRevisionId === undefined ? current.semanticContentRevisionId : input.semanticContentRevisionId
  const activeVectorIndexId = SEMANTIC_STATES_REQUIRING_NO_ACTIVE.has(semanticState)
    ? null
    : input.activeVectorIndexId === undefined ? current.activeVectorIndexId : input.activeVectorIndexId
  const semanticProfileId = SEMANTIC_STATES_REQUIRING_NO_ACTIVE.has(semanticState)
    ? null
    : input.semanticProfileId === undefined ? current.semanticProfileId : input.semanticProfileId
  return {
    documentId: current.documentId,
    localState,
    localProgress: input.localProgress === undefined ? current.localProgress : validateProgress(input.localProgress),
    localError,
    activeContentRevisionId: activeContentRevisionId == null ? null : validateIdentifier(activeContentRevisionId, 'active content revision id', 256),
    semanticConsent,
    semanticState,
    semanticProgress: input.semanticProgress === undefined ? current.semanticProgress : validateProgress(input.semanticProgress),
    semanticError,
    semanticContentRevisionId: semanticContentRevisionId == null ? null : validateIdentifier(semanticContentRevisionId, 'semantic content revision id', 256),
    activeVectorIndexId: activeVectorIndexId == null ? null : validateIdentifier(activeVectorIndexId, 'active vector index id', 256),
    semanticProfileId: semanticProfileId == null ? null : validateIdentifier(semanticProfileId, 'semantic profile id', 256),
    updatedAt: now
  }
}

function validateKnowledge(value: RagDocumentKnowledge): void {
  if (typeof value.semanticConsent !== 'boolean') throw new SqliteRagRepositoryError('RAG_INVALID_SEMANTIC_CONSENT', 'Semantic consent must be boolean')
  validateProgress(value.localProgress)
  validateProgress(value.semanticProgress)
  validateStateError(value.localState, value.localError, 'local index error')
  validateStateError(value.semanticState, value.semanticError, 'semantic index error')
  if (value.localState === 'ready' && (value.activeContentRevisionId === null || value.localProgress !== 100)) {
    throw new SqliteRagRepositoryError('RAG_INVALID_LOCAL_STATE', 'Local ready requires an active content revision and 100% progress')
  }
  if (value.semanticState === 'ready' && (
    value.semanticContentRevisionId === null || value.activeVectorIndexId === null || value.semanticProfileId === null || value.semanticProgress !== 100
  )) {
    throw new SqliteRagRepositoryError('RAG_INVALID_SEMANTIC_STATE', 'Semantic ready requires content, vector, profile, and 100% progress')
  }
  if (SEMANTIC_STATES_REQUIRING_NO_ACTIVE.has(value.semanticState) && (
    value.semanticContentRevisionId !== null || value.activeVectorIndexId !== null || value.semanticProfileId !== null
  )) {
    throw new SqliteRagRepositoryError('RAG_INVALID_SEMANTIC_STATE', 'Disabled, consent, and credential states cannot have active semantic identities')
  }
}

function validateStateError(state: string, error: RagPersistedError | null, label: string): void {
  if (state === 'failed' && error === null) throw new SqliteRagRepositoryError('RAG_ERROR_REQUIRED', `${label} is required for failed state`)
  if (state !== 'failed' && error !== null) throw new SqliteRagRepositoryError('RAG_ERROR_NOT_ALLOWED', `${label} is only allowed for failed state`)
}

function normalizeChunk(chunk: RagChunk): RagChunk {
  const chunkId = validateIdentifier(chunk.chunkId, 'chunk id')
  const contentRevisionId = validateIdentifier(chunk.contentRevisionId, 'content revision id', 256)
  const ordinal = validateInteger(chunk.ordinal, 0, 2_147_483_647, 'chunk ordinal')
  const contentHash = validateText(chunk.contentHash, 'chunk content hash', 512)
  const sourceText = validateText(chunk.sourceText, 'chunk source text', 16 * 1024 * 1024)
  const sectionPath = validateStringArray(chunk.sectionPath, 'section path', 512)
  const mappingIds = validateStringArray(chunk.mappingIds, 'mapping ids', 256)
  const pageStart = validateNullableInteger(chunk.pageStart, 0, 100_000, 'page start')
  const pageEnd = validateNullableInteger(chunk.pageEnd, 0, 100_000, 'page end')
  const sourceStartOffset = validateNullableInteger(chunk.sourceStartOffset, 0, 10_000_000, 'source start offset')
  const sourceEndOffset = validateNullableInteger(chunk.sourceEndOffset, 0, 10_000_000, 'source end offset')
  if (pageStart !== null && pageEnd !== null && pageEnd < pageStart) throw new SqliteRagRepositoryError('RAG_INVALID_CHUNK', 'Page end precedes page start')
  if (sourceStartOffset !== null && sourceEndOffset !== null && sourceEndOffset < sourceStartOffset) throw new SqliteRagRepositoryError('RAG_INVALID_CHUNK', 'Source end offset precedes source start offset')
  if (chunk.offsetUnit !== 'utf16') throw new SqliteRagRepositoryError('RAG_INVALID_CHUNK', 'Only UTF-16 offsets are supported')
  const tokenCount = validateInteger(chunk.tokenCount, 0, 2_147_483_647, 'token count')
  validateEnum(chunk.contentType, ['paragraph', 'heading', 'table', 'formula', 'caption', 'code', 'list', 'other'] as const, 'content type')
  validateEnum(chunk.mappingConfidence, ['exact', 'range', 'media', 'fallback', 'none'] as const, 'mapping confidence')
  return {
    chunkId,
    contentRevisionId,
    ordinal,
    contentHash,
    sourceText,
    sectionPath,
    mappingIds,
    pageStart,
    pageEnd,
    sourceStartOffset,
    sourceEndOffset,
    offsetUnit: 'utf16',
    tokenCount,
    contentType: chunk.contentType,
    mappingConfidence: chunk.mappingConfidence
  }
}

function normalizeError(input: RagErrorInput | undefined, label: string): RagPersistedError | null {
  if (input === undefined || input === null) return null
  const code = validateText(input.code, `${label} code`, 128)
  const message = validateText(input.message, `${label} message`, 4 * 1024)
  const retryable = input.retryable ?? false
  const retryAfterMs = input.retryAfterMs == null ? null : validateInteger(input.retryAfterMs, 0, 86_400_000, `${label} retry delay`)
  return { code, message, retryable, retryAfterMs }
}

function requireError(error: RagPersistedError | null, label: string): RagPersistedError {
  if (!error) throw new SqliteRagRepositoryError('RAG_ERROR_REQUIRED', `${label} is required for failed state`)
  return error
}

function errorFromColumns(code: string | null, message: string | null, retryable: number | null, retryAfterMs: number | null): RagPersistedError | null {
  if (code === null && message === null) return null
  if (code === null || message === null) throw new SqliteRagRepositoryError('RAG_DATA_INVALID', 'Stored RAG error is incomplete')
  return { code, message, retryable: retryable === 1, retryAfterMs }
}

function validateIdentifier(value: string, label: string, max = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\0')) {
    throw new SqliteRagRepositoryError('RAG_INVALID_INPUT', `Invalid ${label}`)
  }
  return value
}

function validateText(value: string, label: string, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\0')) {
    throw new SqliteRagRepositoryError('RAG_INVALID_INPUT', `Invalid ${label}`)
  }
  return value
}

function validateTimestamp(value: string, label: string): string {
  return validateText(value, label, 128)
}

function validateInteger(value: number, min: number, max: number, label: string): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new SqliteRagRepositoryError('RAG_INVALID_INPUT', `Invalid ${label}`)
  return value
}

function validateProgress(value: number): number {
  return validateInteger(value, 0, 100, 'progress')
}

function validateNullableInteger(value: number | null, min: number, max: number, label: string): number | null {
  return value === null ? null : validateInteger(value, min, max, label)
}

function validateEnum<T extends string>(value: T, allowed: readonly T[], label: string): T {
  if (!allowed.includes(value)) throw new SqliteRagRepositoryError('RAG_INVALID_INPUT', `Invalid ${label}`)
  return value
}

function validateStringArray(value: readonly string[], label: string, maxItemLength: number): string[] {
  if (!Array.isArray(value) || value.length > 256) throw new SqliteRagRepositoryError('RAG_INVALID_INPUT', `Invalid ${label}`)
  return value.map((item) => validateText(item, label, maxItemLength))
}

function parseStringArray(value: string, label: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) throw new Error('array required')
    return parsed as string[]
  } catch {
    throw new SqliteRagRepositoryError('RAG_DATA_INVALID', `Stored ${label} is invalid`)
  }
}
