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
} from '@shared/ragTypes'
import { V2Database } from './v2Database'

export type RagContentRevisionState = 'building' | 'ready' | 'stale' | 'failed'
export type RagVariantState = 'pending' | 'ready' | 'failed'
export type RagVectorIndexState = 'queued' | 'building' | 'ready' | 'stale' | 'failed'
export type RagDeletionTombstoneState = 'queued' | 'running' | 'succeeded' | 'failed'
export type RagProfileCapability = 'embedding' | 'rerank' | 'chat'
export type RagProfileMetric = 'cosine' | 'dot' | 'l2'
export type RagProfileState = 'valid' | 'invalid' | 'disabled'

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

export interface RagChunkVariant {
  chunkId: string
  translationArtifactId: string
  translationGeneration: number
  translatedText: string | null
  translatedHash: string | null
  provider: string | null
  model: string | null
  status: RagVariantState
  error: RagPersistedError | null
  createdAt: string
  updatedAt: string
}

export interface RagChunkVariantInput {
  chunkId: string
  translationArtifactId: string
  translationGeneration: number
  translatedText?: string | null
  translatedHash?: string | null
  provider?: string | null
  model?: string | null
  status?: RagVariantState
  error?: RagErrorInput
  now?: string
}

export interface RagProfileRecord {
  profileId: string
  capability: RagProfileCapability
  provider: string
  model: string
  profileFingerprint: string
  dimensions: number | null
  metric: RagProfileMetric
  normalized: boolean
  /** Opaque vault/account reference only; this is never a provider secret. */
  credentialRef: string | null
  status: RagProfileState
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface RagProfileInput {
  profileId?: string
  id?: string
  capability: RagProfileCapability
  provider: string
  model: string
  profileFingerprint: string
  dimensions?: number | null
  metric?: RagProfileMetric
  normalized?: boolean
  credentialRef?: string | null
  status?: RagProfileState
  metadata?: Record<string, unknown>
  now?: string
}

export interface RagVectorIndexRecord {
  vectorIndexId: string
  documentId: string
  contentRevisionId: string
  profileId: string
  backend: string
  dimensions: number
  metric: RagProfileMetric
  normalized: boolean
  state: RagVectorIndexState
  error: RagPersistedError | null
  createdAt: string
  updatedAt: string
}

export interface RagVectorIndexInput {
  documentId?: string
  contentRevisionId: string
  profileId: string
  backend?: string
  dimensions: number
  metric: RagProfileMetric
  normalized?: boolean
  state?: RagVectorIndexState
  error?: RagErrorInput
  vectorIndexId?: string
  id?: string
  now?: string
}

export interface RagVectorIndexTransitionInput {
  vectorIndexId: string
  state: RagVectorIndexState
  error?: RagErrorInput
  now?: string
}

export interface RagEmbeddingRecord {
  vectorIndexId: string
  contentRevisionId: string
  chunkId: string
  dimensions: number
  embedding: Uint8Array
  vectorHash: string | null
  createdAt: string
  updatedAt: string
}

export interface RagEmbeddingInput {
  vectorIndexId: string
  chunkId: string
  contentRevisionId?: string
  dimensions: number
  embedding: Uint8Array | ArrayBuffer
  vectorHash?: string | null
  now?: string
}

export interface RagEmbeddingCacheRecord {
  cacheKey: string
  profileId: string
  contentHash: string
  dimensions: number
  embedding: Uint8Array
  byteSize: number
  lastAccessedAt: string
  createdAt: string
  updatedAt: string
  expiresAt: string | null
}

export interface RagEmbeddingCacheInput {
  cacheKey: string
  profileId: string
  contentHash: string
  dimensions: number
  embedding: Uint8Array | ArrayBuffer
  lastAccessedAt?: string
  expiresAt?: string | null
  now?: string
}

export interface RagDeletionTombstone {
  documentId: string
  state: RagDeletionTombstoneState
  error: RagPersistedError | null
  createdAt: string
  updatedAt: string
}

export interface RagDeletionTransitionInput {
  documentId: string
  state: RagDeletionTombstoneState
  error?: RagErrorInput
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

type VariantRow = {
  chunk_id: string
  translation_artifact_id: string
  translation_generation: number
  translated_text: string | null
  translated_hash: string | null
  provider: string | null
  model: string | null
  status: RagVariantState
  error_code: string | null
  error_message: string | null
  created_at: string
  updated_at: string
}

type ProfileRow = {
  profile_id: string
  capability: RagProfileCapability
  provider: string
  model: string
  profile_fingerprint: string
  dimensions: number | null
  metric: RagProfileMetric
  normalized: number
  credential_ref: string | null
  status: RagProfileState
  metadata_json: string
  created_at: string
  updated_at: string
}

type VectorIndexRow = {
  vector_index_id: string
  document_id: string
  content_revision_id: string
  profile_id: string
  backend: string
  dimensions: number
  metric: RagProfileMetric
  normalized: number
  state: RagVectorIndexState
  error_code: string | null
  error_message: string | null
  created_at: string
  updated_at: string
}

type EmbeddingRow = {
  vector_index_id: string
  content_revision_id: string
  chunk_id: string
  dimensions: number
  embedding: Uint8Array
  vector_hash: string | null
  created_at: string
  updated_at: string
}

type CacheRow = {
  cache_key: string
  profile_id: string
  content_hash: string
  dimensions: number
  embedding: Uint8Array
  byte_size: number
  last_accessed_at: string
  created_at: string
  updated_at: string
  expires_at: string | null
}

type TombstoneRow = {
  document_id: string
  state: RagDeletionTombstoneState
  error_code: string | null
  error_message: string | null
  created_at: string
  updated_at: string
}

const LOCAL_TRANSITIONS: Readonly<Record<LocalIndexState, readonly LocalIndexState[]>> = Object.freeze({
  unindexed: ['queued', 'failed'],
  queued: ['indexing', 'failed'],
  indexing: ['queued', 'ready', 'failed'],
  ready: ['stale'],
  stale: ['queued', 'indexing', 'failed'],
  failed: ['queued']
})

const SEMANTIC_TRANSITIONS: Readonly<Record<SemanticIndexState, readonly SemanticIndexState[]>> = Object.freeze({
  disabled: ['requires-consent'],
  'requires-consent': ['disabled', 'requires-credential'],
  'requires-credential': ['disabled', 'requires-consent', 'queued'],
  queued: ['disabled', 'requires-consent', 'requires-credential', 'indexing', 'failed'],
  indexing: ['queued', 'ready', 'failed'],
  ready: ['stale', 'disabled'],
  stale: ['queued', 'indexing', 'failed', 'disabled', 'requires-consent', 'requires-credential'],
  failed: ['queued', 'disabled', 'requires-consent', 'requires-credential']
})

const CONTENT_TRANSITIONS: Readonly<Record<RagContentRevisionState, readonly RagContentRevisionState[]>> = Object.freeze({
  building: ['ready', 'stale', 'failed'],
  ready: ['stale'],
  stale: ['building', 'failed'],
  failed: ['building']
})

const VECTOR_TRANSITIONS: Readonly<Record<RagVectorIndexState, readonly RagVectorIndexState[]>> = Object.freeze({
  queued: ['building', 'stale', 'failed'],
  building: ['queued', 'ready', 'stale', 'failed'],
  ready: ['stale'],
  stale: ['queued', 'building', 'failed'],
  failed: ['queued', 'building']
})

const TOMBSTONE_TRANSITIONS: Readonly<Record<RagDeletionTombstoneState, readonly RagDeletionTombstoneState[]>> = Object.freeze({
  queued: ['running', 'succeeded', 'failed'],
  running: ['queued', 'succeeded', 'failed'],
  succeeded: ['queued'],
  failed: ['queued', 'running']
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
 * Utility-owned RAG persistence.  It stores canonical source facts and
 * opaque vector/profile metadata; it intentionally does not call a chunker,
 * embedding provider, or runner.  Each mutating operation is one durable
 * transaction so a restart can observe either the old or the new state.
 */
export class SqliteRagRepository {
  private readonly connection: V2Database['connection']
  private readonly selectKnowledge: StatementSync
  private readonly selectRevision: StatementSync
  private readonly selectChunk: StatementSync
  private readonly selectProfile: StatementSync
  private readonly selectVectorIndex: StatementSync

  constructor(private readonly database: V2Database) {
    this.connection = database.connection
    this.selectKnowledge = this.connection.prepare('SELECT * FROM rag_documents WHERE document_id=?')
    this.selectRevision = this.connection.prepare('SELECT * FROM rag_content_revisions WHERE content_revision_id=?')
    this.selectChunk = this.connection.prepare('SELECT * FROM rag_chunks WHERE chunk_id=?')
    this.selectProfile = this.connection.prepare('SELECT * FROM rag_profiles WHERE profile_id=?')
    this.selectVectorIndex = this.connection.prepare('SELECT * FROM rag_vector_indexes WHERE vector_index_id=?')
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

  /**
   * Persist the user's semantic-upload decision independently of credentials.
   * A revoked decision clears semantic identities so an old vector cannot be
   * presented as usable after the user turns the feature off.
   */
  setSemanticConsent(documentId: string, consent: boolean, now?: string): RagDocumentKnowledge {
    const id = validateIdentifier(documentId, 'document id')
    if (typeof consent !== 'boolean') throw new SqliteRagRepositoryError('RAG_INVALID_INPUT', 'Semantic consent must be boolean')
    const timestamp = validateTimestamp(now ?? new Date().toISOString(), 'semantic consent time')
    return this.database.transaction(() => {
      this.ensureDocumentKnowledgeUnsafe(id, timestamp)
      const current = this.getKnowledgeUnsafe(id)!
      const nextSemanticState: SemanticIndexState = consent
        ? current.semanticState === 'disabled' || current.semanticState === 'requires-consent' || current.semanticState === 'failed'
          ? 'requires-credential'
          : current.semanticState
        : 'requires-consent'
      const keepSemanticIdentity = consent && !SEMANTIC_STATES_REQUIRING_NO_ACTIVE.has(nextSemanticState)
      this.connection.prepare(`
        UPDATE rag_documents SET
          semantic_consent=?, semantic_state=?, semantic_progress=?,
          semantic_error_code=NULL, semantic_error_message=NULL,
          semantic_error_retryable=NULL, semantic_error_retry_after_ms=NULL,
          semantic_content_revision_id=?, active_vector_index_id=?, semantic_profile_id=?, updated_at=?
        WHERE document_id=?
      `).run(
        consent ? 1 : 0,
        nextSemanticState,
        keepSemanticIdentity ? current.semanticProgress : 0,
        keepSemanticIdentity ? current.semanticContentRevisionId : null,
        keepSemanticIdentity ? current.activeVectorIndexId : null,
        keepSemanticIdentity ? current.semanticProfileId : null,
        timestamp,
        id
      )
      return this.getKnowledgeUnsafe(id)!
    })
  }

  transitionLocalState(input: {
    documentId: string
    state: LocalIndexState
    progress?: number
    error?: RagErrorInput
    activeContentRevisionId?: string | null
    now?: string
  }): RagDocumentKnowledge {
    const current = this.getDocumentKnowledge(input.documentId)
    if (current && current.localState !== input.state && !LOCAL_TRANSITIONS[current.localState].includes(input.state)) {
      throw new SqliteRagRepositoryError('RAG_INVALID_LOCAL_TRANSITION', `Cannot move local state from ${current.localState} to ${input.state}`)
    }
    return this.upsertDocumentKnowledge({
      documentId: input.documentId,
      localState: input.state,
      localProgress: input.progress,
      localError: input.error,
      activeContentRevisionId: input.activeContentRevisionId,
      now: input.now
    })
  }

  transitionSemanticState(input: {
    documentId: string
    state: SemanticIndexState
    progress?: number
    error?: RagErrorInput
    semanticContentRevisionId?: string | null
    activeVectorIndexId?: string | null
    semanticProfileId?: string | null
    now?: string
  }): RagDocumentKnowledge {
    const current = this.getDocumentKnowledge(input.documentId)
    if (current && current.semanticState !== input.state && !SEMANTIC_TRANSITIONS[current.semanticState].includes(input.state)) {
      throw new SqliteRagRepositoryError('RAG_INVALID_SEMANTIC_TRANSITION', `Cannot move semantic state from ${current.semanticState} to ${input.state}`)
    }
    return this.upsertDocumentKnowledge({
      documentId: input.documentId,
      semanticState: input.state,
      semanticProgress: input.progress,
      semanticError: input.error,
      semanticContentRevisionId: input.semanticContentRevisionId,
      activeVectorIndexId: input.activeVectorIndexId,
      semanticProfileId: input.semanticProfileId,
      now: input.now
    })
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

  listContentRevisions(documentId: string): RagContentRevisionRecord[] {
    const id = validateIdentifier(documentId, 'document id')
    return (this.connection.prepare(`
      SELECT * FROM rag_content_revisions WHERE document_id=? ORDER BY lexical_generation DESC, created_at DESC, content_revision_id ASC
    `).all(id) as unknown as ContentRevisionRow[]).map(fromContentRevisionRow)
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

  activateContentRevision(contentRevisionId: string, now?: string): RagContentRevisionRecord {
    const id = validateIdentifier(contentRevisionId, 'content revision id')
    const timestamp = validateTimestamp(now ?? new Date().toISOString(), 'content activation time')
    return this.database.transaction(() => {
      const revision = this.requireRevisionUnsafe(id)
      if (revision.state !== 'ready') {
        throw new SqliteRagRepositoryError('RAG_CONTENT_NOT_READY', 'Only a ready content revision can be activated')
      }
      const knowledge = this.requireKnowledgeUnsafe(revision.document_id)
      this.connection.prepare(`
        UPDATE rag_documents SET
          local_state='ready', local_progress=100, local_error_code=NULL, local_error_message=NULL,
          local_error_retryable=NULL, local_error_retry_after_ms=NULL, active_content_revision_id=?, updated_at=?
        WHERE document_id=?
      `).run(id, timestamp, revision.document_id)
      if (
        knowledge.semanticState === 'ready' ||
        knowledge.semanticState === 'indexing'
      ) {
        this.connection.prepare(`
          UPDATE rag_documents SET semantic_state='stale', semantic_progress=0,
            semantic_error_code=NULL, semantic_error_message=NULL, semantic_error_retryable=NULL,
            semantic_error_retry_after_ms=NULL, semantic_content_revision_id=NULL,
            active_vector_index_id=NULL, semantic_profile_id=NULL, updated_at=?
          WHERE document_id=?
        `).run(timestamp, revision.document_id)
      }
      return fromContentRevisionRow(revision)
    })
  }

  upsertChunk(chunk: RagChunk, now?: string): RagChunk {
    const normalized = normalizeChunk(chunk)
    const timestamp = validateTimestamp(now ?? new Date().toISOString(), 'chunk time')
    return this.database.transaction(() => {
      this.upsertChunkUnsafe(normalized, timestamp)
      return this.getChunkUnsafe(normalized.chunkId)!
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

  getChunk(chunkId: string): RagChunk | null {
    const row = this.selectChunk.get(validateIdentifier(chunkId, 'chunk id')) as ChunkRow | undefined
    return row ? fromChunkRow(row) : null
  }

  listChunks(contentRevisionId: string): RagChunk[] {
    const id = validateIdentifier(contentRevisionId, 'content revision id')
    return (this.connection.prepare('SELECT * FROM rag_chunks WHERE content_revision_id=? ORDER BY ordinal ASC, chunk_id ASC').all(id) as unknown as ChunkRow[]).map(fromChunkRow)
  }

  upsertChunkVariant(input: RagChunkVariantInput): RagChunkVariant {
    const chunkId = validateIdentifier(input.chunkId, 'chunk id')
    const artifactId = validateIdentifier(input.translationArtifactId, 'translation artifact id')
    const generation = validateInteger(input.translationGeneration, 0, 2_147_483_647, 'translation generation')
    const status = input.status ?? 'pending'
    const translatedText = input.translatedText == null ? null : validateText(input.translatedText, 'translated text', 16 * 1024 * 1024)
    const translatedHash = input.translatedHash == null ? null : validateText(input.translatedHash, 'translated hash', 512)
    const provider = input.provider == null ? null : validateText(input.provider, 'translation provider', 128)
    const model = input.model == null ? null : validateText(input.model, 'translation model', 256)
    const error = normalizeError(input.error, 'variant error')
    validateVariant(status, translatedText, error)
    const now = validateTimestamp(input.now ?? new Date().toISOString(), 'variant time')
    return this.database.transaction(() => {
      this.requireChunkUnsafe(chunkId)
      const existing = this.connection.prepare(`
        SELECT * FROM rag_chunk_variants
        WHERE chunk_id=? AND translation_artifact_id=? AND translation_generation=?
      `).get(chunkId, artifactId, generation) as VariantRow | undefined
      this.connection.prepare(`
        INSERT INTO rag_chunk_variants(
          chunk_id, translation_artifact_id, translation_generation, translated_text,
          translated_hash, provider, model, status, error_code, error_message, created_at, updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(chunk_id, translation_artifact_id, translation_generation) DO UPDATE SET
          translated_text=excluded.translated_text, translated_hash=excluded.translated_hash,
          provider=excluded.provider, model=excluded.model, status=excluded.status,
          error_code=excluded.error_code, error_message=excluded.error_message, updated_at=excluded.updated_at
      `).run(
        chunkId, artifactId, generation, translatedText, translatedHash, provider, model,
        status, error?.code ?? null, error?.message ?? null, existing?.created_at ?? now, now
      )
      return this.getVariantUnsafe(chunkId, artifactId, generation)!
    })
  }

  listChunkVariants(chunkId: string): RagChunkVariant[] {
    const id = validateIdentifier(chunkId, 'chunk id')
    return (this.connection.prepare(`
      SELECT * FROM rag_chunk_variants WHERE chunk_id=? ORDER BY translation_generation DESC, translation_artifact_id ASC
    `).all(id) as unknown as VariantRow[]).map(fromVariantRow)
  }

  getChunkVariant(input: Pick<RagChunkVariantInput, 'chunkId' | 'translationArtifactId' | 'translationGeneration'>): RagChunkVariant | null {
    const chunkId = validateIdentifier(input.chunkId, 'chunk id')
    const artifactId = validateIdentifier(input.translationArtifactId, 'translation artifact id')
    const generation = validateInteger(input.translationGeneration, 0, 2_147_483_647, 'translation generation')
    const row = this.connection.prepare(`
      SELECT * FROM rag_chunk_variants WHERE chunk_id=? AND translation_artifact_id=? AND translation_generation=?
    `).get(chunkId, artifactId, generation) as VariantRow | undefined
    return row ? fromVariantRow(row) : null
  }

  upsertProfile(input: RagProfileInput): RagProfileRecord {
    const profileId = validateIdentifier(input.profileId ?? input.id ?? randomUUID(), 'profile id', 256)
    const capability = validateEnum(input.capability, ['embedding', 'rerank', 'chat'] as const, 'profile capability')
    const provider = validateText(input.provider, 'profile provider', 128)
    const model = validateText(input.model, 'profile model', 256)
    const profileFingerprint = validateText(input.profileFingerprint, 'profile fingerprint', 256)
    const dimensions = input.dimensions == null ? null : validateInteger(input.dimensions, 1, 2_147_483_647, 'profile dimensions')
    const metric = input.metric ?? 'cosine'
    validateEnum(metric, ['cosine', 'dot', 'l2'] as const, 'profile metric')
    const normalized = input.normalized ?? true
    const status = input.status ?? 'valid'
    validateEnum(status, ['valid', 'invalid', 'disabled'] as const, 'profile status')
    const credentialRef = input.credentialRef == null ? null : normalizeOpaqueCredentialRef(input.credentialRef)
    const metadata = normalizeJsonObject(input.metadata ?? {}, 'profile metadata')
    const now = validateTimestamp(input.now ?? new Date().toISOString(), 'profile time')
    return this.database.transaction(() => {
      const existing = this.selectProfile.get(profileId) as ProfileRow | undefined
      this.connection.prepare(`
        INSERT INTO rag_profiles(
          profile_id, capability, provider, model, profile_fingerprint, dimensions,
          metric, normalized, credential_ref, status, metadata_json, created_at, updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(profile_id) DO UPDATE SET
          capability=excluded.capability, provider=excluded.provider, model=excluded.model,
          profile_fingerprint=excluded.profile_fingerprint, dimensions=excluded.dimensions,
          metric=excluded.metric, normalized=excluded.normalized, credential_ref=excluded.credential_ref,
          status=excluded.status, metadata_json=excluded.metadata_json, updated_at=excluded.updated_at
      `).run(
        profileId, capability, provider, model, profileFingerprint, dimensions,
        metric, normalized ? 1 : 0, credentialRef, status, JSON.stringify(metadata), existing?.created_at ?? now, now
      )
      return this.getProfileUnsafe(profileId)!
    })
  }

  getProfile(profileId: string): RagProfileRecord | null {
    const row = this.selectProfile.get(validateIdentifier(profileId, 'profile id', 256)) as ProfileRow | undefined
    return row ? fromProfileRow(row) : null
  }

  listProfiles(capability?: RagProfileCapability): RagProfileRecord[] {
    if (capability !== undefined) validateEnum(capability, ['embedding', 'rerank', 'chat'] as const, 'profile capability')
    const rows = capability === undefined
      ? this.connection.prepare('SELECT * FROM rag_profiles ORDER BY capability ASC, profile_id ASC').all()
      : this.connection.prepare('SELECT * FROM rag_profiles WHERE capability=? ORDER BY profile_id ASC').all(capability)
    return (rows as unknown as ProfileRow[]).map(fromProfileRow)
  }

  upsertVectorIndex(input: RagVectorIndexInput): RagVectorIndexRecord {
    const revisionId = validateIdentifier(input.contentRevisionId, 'content revision id')
    const profileId = validateIdentifier(input.profileId, 'profile id', 256)
    const backend = validateText(input.backend ?? 'sqlite-exact', 'vector backend', 128)
    const dimensions = validateInteger(input.dimensions, 1, 2_147_483_647, 'vector dimensions')
    const metric = validateEnum(input.metric, ['cosine', 'dot', 'l2'] as const, 'vector metric')
    const normalized = input.normalized ?? true
    const state = input.state ?? 'queued'
    validateEnum(state, ['queued', 'building', 'ready', 'stale', 'failed'] as const, 'vector index state')
    const error = normalizeError(input.error, 'vector index error')
    validateStateError(state, error, 'vector index error')
    const id = validateIdentifier(input.vectorIndexId ?? input.id ?? randomUUID(), 'vector index id', 256)
    const now = validateTimestamp(input.now ?? new Date().toISOString(), 'vector index time')
    return this.database.transaction(() => {
      const revision = this.requireRevisionUnsafe(revisionId)
      const documentId = input.documentId == null ? revision.document_id : validateIdentifier(input.documentId, 'document id')
      if (documentId !== revision.document_id) throw new SqliteRagRepositoryError('RAG_DOCUMENT_MISMATCH', 'Vector index document does not match its content revision')
      this.ensureDocumentKnowledgeUnsafe(documentId, now)
      if (!this.getProfileUnsafe(profileId)) throw new SqliteRagRepositoryError('RAG_PROFILE_NOT_FOUND', 'Vector index profile does not exist')
      const deduplicated = this.connection.prepare(`
        SELECT * FROM rag_vector_indexes WHERE document_id=? AND content_revision_id=? AND profile_id=?
      `).get(documentId, revisionId, profileId) as VectorIndexRow | undefined
      if (deduplicated && deduplicated.vector_index_id !== id) return fromVectorIndexRow(deduplicated)
      const existing = this.selectVectorIndex.get(id) as VectorIndexRow | undefined
      if (existing && (existing.document_id !== documentId || existing.content_revision_id !== revisionId || existing.profile_id !== profileId)) {
        throw new SqliteRagRepositoryError('RAG_VECTOR_INDEX_ID_CONFLICT', 'Vector index ID belongs to another index')
      }
      this.connection.prepare(`
        INSERT INTO rag_vector_indexes(
          vector_index_id, document_id, content_revision_id, profile_id, backend,
          dimensions, metric, normalized, state, error_code, error_message, created_at, updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(vector_index_id) DO UPDATE SET
          backend=excluded.backend, dimensions=excluded.dimensions, metric=excluded.metric,
          normalized=excluded.normalized, state=excluded.state, error_code=excluded.error_code,
          error_message=excluded.error_message, updated_at=excluded.updated_at
      `).run(
        id, documentId, revisionId, profileId, backend, dimensions, metric, normalized ? 1 : 0,
        state, error?.code ?? null, error?.message ?? null, existing?.created_at ?? now, now
      )
      return this.getVectorIndexUnsafe(id)!
    })
  }

  getVectorIndex(vectorIndexId: string): RagVectorIndexRecord | null {
    const row = this.selectVectorIndex.get(validateIdentifier(vectorIndexId, 'vector index id', 256)) as VectorIndexRow | undefined
    return row ? fromVectorIndexRow(row) : null
  }

  listVectorIndexes(documentId: string, contentRevisionId?: string): RagVectorIndexRecord[] {
    const id = validateIdentifier(documentId, 'document id')
    const rows = contentRevisionId === undefined
      ? this.connection.prepare('SELECT * FROM rag_vector_indexes WHERE document_id=? ORDER BY updated_at DESC, vector_index_id ASC').all(id)
      : this.connection.prepare('SELECT * FROM rag_vector_indexes WHERE document_id=? AND content_revision_id=? ORDER BY updated_at DESC, vector_index_id ASC').all(id, validateIdentifier(contentRevisionId, 'content revision id'))
    return (rows as unknown as VectorIndexRow[]).map(fromVectorIndexRow)
  }

  transitionVectorIndex(input: RagVectorIndexTransitionInput): RagVectorIndexRecord {
    const id = validateIdentifier(input.vectorIndexId, 'vector index id', 256)
    const state = input.state
    validateEnum(state, ['queued', 'building', 'ready', 'stale', 'failed'] as const, 'vector index state')
    const error = normalizeError(input.error, 'vector index error')
    const now = validateTimestamp(input.now ?? new Date().toISOString(), 'vector index transition time')
    return this.database.transaction(() => {
      const current = this.requireVectorIndexUnsafe(id)
      if (current.state !== state && !VECTOR_TRANSITIONS[current.state].includes(state)) {
        throw new SqliteRagRepositoryError('RAG_INVALID_VECTOR_TRANSITION', `Cannot move vector index from ${current.state} to ${state}`)
      }
      const finalError = state === 'failed' ? requireError(error ?? fromVectorIndexRow(current).error, 'vector index error') : null
      this.connection.prepare(`
        UPDATE rag_vector_indexes SET state=?, error_code=?, error_message=?, updated_at=? WHERE vector_index_id=?
      `).run(state, finalError?.code ?? null, finalError?.message ?? null, now, id)
      return this.getVectorIndexUnsafe(id)!
    })
  }

  activateVectorIndex(vectorIndexId: string, now?: string): RagDocumentKnowledge {
    const id = validateIdentifier(vectorIndexId, 'vector index id', 256)
    const timestamp = validateTimestamp(now ?? new Date().toISOString(), 'vector activation time')
    return this.database.transaction(() => {
      const index = this.requireVectorIndexUnsafe(id)
      if (index.state !== 'ready') throw new SqliteRagRepositoryError('RAG_VECTOR_NOT_READY', 'Only a ready vector index can be activated')
      const profile = this.getProfileUnsafe(index.profile_id)
      if (!profile || profile.status !== 'valid') throw new SqliteRagRepositoryError('RAG_PROFILE_INVALID', 'Vector index profile is not valid')
      const knowledge = this.requireKnowledgeUnsafe(index.document_id)
      if (knowledge.localState !== 'ready' || knowledge.activeContentRevisionId !== index.content_revision_id) {
        throw new SqliteRagRepositoryError('RAG_CONTENT_NOT_READY', 'The local content revision must be ready before semantic activation')
      }
      this.connection.prepare(`
        UPDATE rag_documents SET semantic_state='ready', semantic_progress=100,
          semantic_error_code=NULL, semantic_error_message=NULL, semantic_error_retryable=NULL,
          semantic_error_retry_after_ms=NULL, semantic_content_revision_id=?, active_vector_index_id=?,
          semantic_profile_id=?, updated_at=? WHERE document_id=?
      `).run(index.content_revision_id, id, index.profile_id, timestamp, index.document_id)
      return this.getKnowledgeUnsafe(index.document_id)!
    })
  }

  upsertEmbedding(input: RagEmbeddingInput): RagEmbeddingRecord {
    const vectorIndexId = validateIdentifier(input.vectorIndexId, 'vector index id', 256)
    const chunkId = validateIdentifier(input.chunkId, 'chunk id')
    const dimensions = validateInteger(input.dimensions, 1, 2_147_483_647, 'embedding dimensions')
    const bytes = normalizeEmbedding(input.embedding, dimensions)
    const vectorHash = input.vectorHash == null ? null : validateText(input.vectorHash, 'vector hash', 512)
    const now = validateTimestamp(input.now ?? new Date().toISOString(), 'embedding time')
    return this.database.transaction(() => {
      const index = this.requireVectorIndexUnsafe(vectorIndexId)
      const contentRevisionId = input.contentRevisionId == null
        ? index.content_revision_id
        : validateIdentifier(input.contentRevisionId, 'content revision id')
      if (contentRevisionId !== index.content_revision_id) throw new SqliteRagRepositoryError('RAG_CONTENT_MISMATCH', 'Embedding revision does not match its vector index')
      this.requireChunkUnsafe(chunkId)
      const chunk = this.getChunkUnsafe(chunkId)!
      if (chunk.contentRevisionId !== contentRevisionId) throw new SqliteRagRepositoryError('RAG_CONTENT_MISMATCH', 'Embedding chunk does not match its vector index')
      const existing = this.connection.prepare('SELECT created_at FROM rag_embeddings WHERE vector_index_id=? AND chunk_id=?').get(vectorIndexId, chunkId) as { created_at: string } | undefined
      this.connection.prepare(`
        INSERT INTO rag_embeddings(
          vector_index_id, content_revision_id, chunk_id, dimensions, embedding,
          vector_hash, created_at, updated_at
        ) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(vector_index_id, chunk_id) DO UPDATE SET
          dimensions=excluded.dimensions, embedding=excluded.embedding, vector_hash=excluded.vector_hash,
          updated_at=excluded.updated_at
      `).run(vectorIndexId, contentRevisionId, chunkId, dimensions, Buffer.from(bytes), vectorHash, existing?.created_at ?? now, now)
      return this.getEmbeddingUnsafe(vectorIndexId, chunkId)!
    })
  }

  getEmbedding(vectorIndexId: string, chunkId: string): RagEmbeddingRecord | null {
    const row = this.connection.prepare('SELECT * FROM rag_embeddings WHERE vector_index_id=? AND chunk_id=?').get(
      validateIdentifier(vectorIndexId, 'vector index id', 256),
      validateIdentifier(chunkId, 'chunk id')
    ) as EmbeddingRow | undefined
    return row ? fromEmbeddingRow(row) : null
  }

  listEmbeddings(vectorIndexId: string): RagEmbeddingRecord[] {
    const id = validateIdentifier(vectorIndexId, 'vector index id', 256)
    return (this.connection.prepare('SELECT * FROM rag_embeddings WHERE vector_index_id=? ORDER BY chunk_id ASC').all(id) as unknown as EmbeddingRow[]).map(fromEmbeddingRow)
  }

  upsertEmbeddingCache(input: RagEmbeddingCacheInput): RagEmbeddingCacheRecord {
    const cacheKey = validateIdentifier(input.cacheKey, 'cache key', 512)
    const profileId = validateIdentifier(input.profileId, 'profile id', 256)
    const contentHash = validateText(input.contentHash, 'cache content hash', 512)
    const dimensions = validateInteger(input.dimensions, 1, 2_147_483_647, 'cache dimensions')
    const bytes = normalizeEmbedding(input.embedding, dimensions)
    const now = validateTimestamp(input.now ?? new Date().toISOString(), 'embedding cache time')
    const lastAccessedAt = validateTimestamp(input.lastAccessedAt ?? now, 'cache access time')
    const expiresAt = input.expiresAt == null ? null : validateTimestamp(input.expiresAt, 'cache expiry time')
    return this.database.transaction(() => {
      this.requireProfileUnsafe(profileId)
      const byIdentity = this.connection.prepare('SELECT * FROM rag_embedding_cache WHERE profile_id=? AND content_hash=?').get(profileId, contentHash) as CacheRow | undefined
      if (byIdentity && byIdentity.cache_key !== cacheKey) return fromCacheRow(byIdentity)
      const existing = this.connection.prepare('SELECT created_at FROM rag_embedding_cache WHERE cache_key=?').get(cacheKey) as { created_at: string } | undefined
      this.connection.prepare(`
        INSERT INTO rag_embedding_cache(
          cache_key, profile_id, content_hash, dimensions, embedding, byte_size,
          last_accessed_at, created_at, updated_at, expires_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(cache_key) DO UPDATE SET
          profile_id=excluded.profile_id, content_hash=excluded.content_hash,
          dimensions=excluded.dimensions, embedding=excluded.embedding, byte_size=excluded.byte_size,
          last_accessed_at=excluded.last_accessed_at, updated_at=excluded.updated_at, expires_at=excluded.expires_at
      `).run(cacheKey, profileId, contentHash, dimensions, Buffer.from(bytes), bytes.byteLength, lastAccessedAt, existing?.created_at ?? now, now, expiresAt)
      return this.getEmbeddingCacheUnsafe(cacheKey)!
    })
  }

  getEmbeddingCache(cacheKey: string): RagEmbeddingCacheRecord | null {
    const row = this.connection.prepare('SELECT * FROM rag_embedding_cache WHERE cache_key=?').get(validateIdentifier(cacheKey, 'cache key', 512)) as CacheRow | undefined
    return row ? fromCacheRow(row) : null
  }

  getEmbeddingCacheByIdentity(profileId: string, contentHash: string): RagEmbeddingCacheRecord | null {
    const row = this.connection.prepare('SELECT * FROM rag_embedding_cache WHERE profile_id=? AND content_hash=?').get(
      validateIdentifier(profileId, 'profile id', 256), validateText(contentHash, 'cache content hash', 512)
    ) as CacheRow | undefined
    return row ? fromCacheRow(row) : null
  }

  touchEmbeddingCache(cacheKey: string, now?: string): RagEmbeddingCacheRecord {
    const key = validateIdentifier(cacheKey, 'cache key', 512)
    const timestamp = validateTimestamp(now ?? new Date().toISOString(), 'cache access time')
    return this.database.transaction(() => {
      if (!this.getEmbeddingCacheUnsafe(key)) throw new SqliteRagRepositoryError('RAG_CACHE_NOT_FOUND', 'Embedding cache entry does not exist')
      this.connection.prepare('UPDATE rag_embedding_cache SET last_accessed_at=?, updated_at=? WHERE cache_key=?').run(timestamp, timestamp, key)
      return this.getEmbeddingCacheUnsafe(key)!
    })
  }

  evictEmbeddingCache(maxBytes: number): string[] {
    const limit = validateInteger(maxBytes, 0, Number.MAX_SAFE_INTEGER, 'cache byte limit')
    return this.database.transaction(() => {
      const rows = this.connection.prepare('SELECT cache_key, byte_size FROM rag_embedding_cache ORDER BY last_accessed_at ASC, cache_key ASC').all() as Array<{ cache_key: string; byte_size: number }>
      let total = rows.reduce((sum, row) => sum + row.byte_size, 0)
      const evicted: string[] = []
      for (const row of rows) {
        if (total <= limit) break
        this.connection.prepare('DELETE FROM rag_embedding_cache WHERE cache_key=?').run(row.cache_key)
        total -= row.byte_size
        evicted.push(row.cache_key)
      }
      return evicted
    })
  }

  queueDocumentDeletion(documentId: string, now?: string): RagDeletionTombstone {
    return this.transitionDeletionTombstone({ documentId, state: 'queued', now })
  }

  getDeletionTombstone(documentId: string): RagDeletionTombstone | null {
    const row = this.connection.prepare('SELECT * FROM rag_deletion_tombstones WHERE document_id=?').get(validateIdentifier(documentId, 'document id')) as TombstoneRow | undefined
    return row ? fromTombstoneRow(row) : null
  }

  transitionDeletionTombstone(input: RagDeletionTransitionInput): RagDeletionTombstone {
    const documentId = validateIdentifier(input.documentId, 'document id')
    const state = validateEnum(input.state, ['queued', 'running', 'succeeded', 'failed'] as const, 'deletion state')
    const error = normalizeError(input.error, 'deletion error')
    validateStateError(state, error, 'deletion error')
    const now = validateTimestamp(input.now ?? new Date().toISOString(), 'deletion time')
    return this.database.transaction(() => {
      const current = this.connection.prepare('SELECT * FROM rag_deletion_tombstones WHERE document_id=?').get(documentId) as TombstoneRow | undefined
      if (current && current.state !== state && !TOMBSTONE_TRANSITIONS[current.state].includes(state)) {
        throw new SqliteRagRepositoryError('RAG_INVALID_DELETION_TRANSITION', `Cannot move deletion from ${current.state} to ${state}`)
      }
      this.connection.prepare(`
        INSERT INTO rag_deletion_tombstones(document_id, state, error_code, error_message, created_at, updated_at)
        VALUES(?,?,?,?,?,?)
        ON CONFLICT(document_id) DO UPDATE SET state=excluded.state, error_code=excluded.error_code,
          error_message=excluded.error_message, updated_at=excluded.updated_at
      `).run(documentId, state, error?.code ?? null, error?.message ?? null, current?.created_at ?? now, now)
      return this.getDeletionTombstoneUnsafe(documentId)!
    })
  }

  /**
   * Clears only RAG rows belonging to a document.  The tombstone has no FK to
   * documents on purpose, so it survives the caller's subsequent document
   * deletion and can drive external app-index cleanup after a restart.
   */
  deleteDocumentRagData(documentId: string, options: { queueDeletion?: boolean; now?: string } = {}): void {
    const id = validateIdentifier(documentId, 'document id')
    const now = validateTimestamp(options.now ?? new Date().toISOString(), 'RAG deletion time')
    this.database.transaction(() => {
      if (options.queueDeletion !== false) {
        const current = this.connection.prepare('SELECT state, created_at FROM rag_deletion_tombstones WHERE document_id=?').get(id) as { state: RagDeletionTombstoneState; created_at: string } | undefined
        if (!current || current.state !== 'queued') {
          this.connection.prepare(`
            INSERT INTO rag_deletion_tombstones(document_id, state, error_code, error_message, created_at, updated_at)
            VALUES(?, 'queued', NULL, NULL, ?, ?)
            ON CONFLICT(document_id) DO UPDATE SET state='queued', error_code=NULL, error_message=NULL, updated_at=excluded.updated_at
          `).run(id, current?.created_at ?? now, now)
        }
      }
      // Clear outgoing active-revision FKs first.  This also makes explicit
      // deletion safe if a caller invokes this before deleting documents.
      this.connection.prepare(`
        UPDATE rag_documents SET local_state='unindexed', local_progress=0,
          local_error_code=NULL, local_error_message=NULL, local_error_retryable=NULL,
          local_error_retry_after_ms=NULL, active_content_revision_id=NULL,
          semantic_state='disabled', semantic_progress=0, semantic_error_code=NULL,
          semantic_error_message=NULL, semantic_error_retryable=NULL,
          semantic_error_retry_after_ms=NULL, semantic_content_revision_id=NULL,
          active_vector_index_id=NULL, semantic_profile_id=NULL, updated_at=?
        WHERE document_id=?
      `).run(now, id)
      this.connection.prepare('DELETE FROM rag_documents WHERE document_id=?').run(id)
      // These explicit deletes make the operation robust if a partially
      // created database contains rows without the normal parent row.
      this.connection.prepare('DELETE FROM rag_vector_indexes WHERE document_id=?').run(id)
      this.connection.prepare('DELETE FROM rag_content_revisions WHERE document_id=?').run(id)
    })
  }

  finalizeDocumentDeletion(documentId: string, now?: string): RagDeletionTombstone {
    return this.transitionDeletionTombstone({ documentId, state: 'succeeded', now })
  }

  private getKnowledgeUnsafe(documentId: string): RagDocumentKnowledge | null {
    const row = this.selectKnowledge.get(documentId) as KnowledgeRow | undefined
    return row ? fromKnowledgeRow(row) : null
  }

  private requireKnowledgeUnsafe(documentId: string): RagDocumentKnowledge {
    const knowledge = this.getKnowledgeUnsafe(documentId)
    if (!knowledge) throw new SqliteRagRepositoryError('RAG_DOCUMENT_NOT_FOUND', 'RAG document row does not exist')
    return knowledge
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

  private getChunkUnsafe(chunkId: string): RagChunk | null {
    const row = this.selectChunk.get(chunkId) as ChunkRow | undefined
    return row ? fromChunkRow(row) : null
  }

  private requireChunkUnsafe(chunkId: string): ChunkRow {
    const row = this.selectChunk.get(chunkId) as ChunkRow | undefined
    if (!row) throw new SqliteRagRepositoryError('RAG_CHUNK_NOT_FOUND', 'Chunk does not exist')
    return row
  }

  private getVariantUnsafe(chunkId: string, artifactId: string, generation: number): RagChunkVariant | null {
    const row = this.connection.prepare(`
      SELECT * FROM rag_chunk_variants WHERE chunk_id=? AND translation_artifact_id=? AND translation_generation=?
    `).get(chunkId, artifactId, generation) as VariantRow | undefined
    return row ? fromVariantRow(row) : null
  }

  private getProfileUnsafe(profileId: string): RagProfileRecord | null {
    const row = this.selectProfile.get(profileId) as ProfileRow | undefined
    return row ? fromProfileRow(row) : null
  }

  private requireProfileUnsafe(profileId: string): ProfileRow {
    const row = this.selectProfile.get(profileId) as ProfileRow | undefined
    if (!row) throw new SqliteRagRepositoryError('RAG_PROFILE_NOT_FOUND', 'Profile does not exist')
    return row
  }

  private getVectorIndexUnsafe(vectorIndexId: string): RagVectorIndexRecord | null {
    const row = this.selectVectorIndex.get(vectorIndexId) as VectorIndexRow | undefined
    return row ? fromVectorIndexRow(row) : null
  }

  private requireVectorIndexUnsafe(vectorIndexId: string): VectorIndexRow {
    const row = this.selectVectorIndex.get(vectorIndexId) as VectorIndexRow | undefined
    if (!row) throw new SqliteRagRepositoryError('RAG_VECTOR_INDEX_NOT_FOUND', 'Vector index does not exist')
    return row
  }

  private getEmbeddingUnsafe(vectorIndexId: string, chunkId: string): RagEmbeddingRecord | null {
    const row = this.connection.prepare('SELECT * FROM rag_embeddings WHERE vector_index_id=? AND chunk_id=?').get(vectorIndexId, chunkId) as EmbeddingRow | undefined
    return row ? fromEmbeddingRow(row) : null
  }

  private getEmbeddingCacheUnsafe(cacheKey: string): RagEmbeddingCacheRecord | null {
    const row = this.connection.prepare('SELECT * FROM rag_embedding_cache WHERE cache_key=?').get(cacheKey) as CacheRow | undefined
    return row ? fromCacheRow(row) : null
  }

  private getDeletionTombstoneUnsafe(documentId: string): RagDeletionTombstone | null {
    const row = this.connection.prepare('SELECT * FROM rag_deletion_tombstones WHERE document_id=?').get(documentId) as TombstoneRow | undefined
    return row ? fromTombstoneRow(row) : null
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

function fromVariantRow(row: VariantRow): RagChunkVariant {
  return {
    chunkId: row.chunk_id,
    translationArtifactId: row.translation_artifact_id,
    translationGeneration: row.translation_generation,
    translatedText: row.translated_text,
    translatedHash: row.translated_hash,
    provider: row.provider,
    model: row.model,
    status: row.status,
    error: errorFromColumns(row.error_code, row.error_message, null, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function fromProfileRow(row: ProfileRow): RagProfileRecord {
  return {
    profileId: row.profile_id,
    capability: row.capability,
    provider: row.provider,
    model: row.model,
    profileFingerprint: row.profile_fingerprint,
    dimensions: row.dimensions,
    metric: row.metric,
    normalized: row.normalized === 1,
    credentialRef: row.credential_ref,
    status: row.status,
    metadata: parseJsonObject(row.metadata_json, 'profile metadata'),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function fromVectorIndexRow(row: VectorIndexRow): RagVectorIndexRecord {
  return {
    vectorIndexId: row.vector_index_id,
    documentId: row.document_id,
    contentRevisionId: row.content_revision_id,
    profileId: row.profile_id,
    backend: row.backend,
    dimensions: row.dimensions,
    metric: row.metric,
    normalized: row.normalized === 1,
    state: row.state,
    error: errorFromColumns(row.error_code, row.error_message, null, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function fromEmbeddingRow(row: EmbeddingRow): RagEmbeddingRecord {
  return {
    vectorIndexId: row.vector_index_id,
    contentRevisionId: row.content_revision_id,
    chunkId: row.chunk_id,
    dimensions: row.dimensions,
    embedding: new Uint8Array(row.embedding),
    vectorHash: row.vector_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function fromCacheRow(row: CacheRow): RagEmbeddingCacheRecord {
  return {
    cacheKey: row.cache_key,
    profileId: row.profile_id,
    contentHash: row.content_hash,
    dimensions: row.dimensions,
    embedding: new Uint8Array(row.embedding),
    byteSize: row.byte_size,
    lastAccessedAt: row.last_accessed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at
  }
}

function fromTombstoneRow(row: TombstoneRow): RagDeletionTombstone {
  return {
    documentId: row.document_id,
    state: row.state,
    error: errorFromColumns(row.error_code, row.error_message, null, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at
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

function validateVariant(state: RagVariantState, translatedText: string | null, error: RagPersistedError | null): void {
  validateStateError(state, error, 'variant error')
  if (state === 'ready' && translatedText === null) throw new SqliteRagRepositoryError('RAG_VARIANT_NOT_READY', 'Ready translation variant requires text')
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

function normalizeJsonObject(value: Record<string, unknown>, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SqliteRagRepositoryError('RAG_INVALID_INPUT', `Invalid ${label}`)
  try {
    const serialized = JSON.stringify(value)
    if (serialized.length > 64 * 1024) throw new Error('too large')
    return JSON.parse(serialized) as Record<string, unknown>
  } catch {
    throw new SqliteRagRepositoryError('RAG_INVALID_INPUT', `Invalid ${label}`)
  }
}

function parseJsonObject(value: string, label: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object required')
    return parsed as Record<string, unknown>
  } catch {
    throw new SqliteRagRepositoryError('RAG_DATA_INVALID', `Stored ${label} is invalid`)
  }
}

function normalizeOpaqueCredentialRef(value: string): string {
  const ref = validateText(value, 'credential reference', 256)
  if (/\s/u.test(ref) || /(?:bearer|api[-_ ]?key|secret|password)\s*[:=]/iu.test(ref)) {
    throw new SqliteRagRepositoryError('RAG_PLAINTEXT_SECRET', 'Only an opaque credential reference may be persisted')
  }
  return ref
}

function normalizeEmbedding(value: Uint8Array | ArrayBuffer, dimensions: number): Uint8Array {
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value)
  if (bytes.byteLength !== dimensions * Float32Array.BYTES_PER_ELEMENT) {
    throw new SqliteRagRepositoryError('RAG_INVALID_VECTOR', 'Embedding byte length does not match dimensions')
  }
  return bytes.slice()
}
