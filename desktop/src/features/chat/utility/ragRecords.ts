import type {
  RagChunk,
  RagChunkContentType,
  RagMappingConfidence
} from '../contract/ragChunk'
import type { LocalIndexState, SemanticIndexState } from '../contract/ragSchemas'

/** Records, stored rows and validation of the chat index tables (rag_*), shared by SqliteRagRepository. */
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

export type KnowledgeRow = {
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

export type ContentRevisionRow = {
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

export type ChunkRow = {
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

export const CONTENT_TRANSITIONS: Readonly<Record<RagContentRevisionState, readonly RagContentRevisionState[]>> = Object.freeze({
  building: ['ready', 'stale', 'failed'],
  ready: ['stale'],
  stale: ['building', 'failed'],
  failed: ['building']
})

export const LOCAL_STATES_REQUIRING_NO_ACTIVE = new Set<LocalIndexState>(['unindexed'])
export const SEMANTIC_STATES_REQUIRING_NO_ACTIVE = new Set<SemanticIndexState>(['disabled', 'requires-consent', 'requires-credential'])

export class SqliteRagRepositoryError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message)
    this.name = 'SqliteRagRepositoryError'
  }
}


export function fromKnowledgeRow(row: KnowledgeRow): RagDocumentKnowledge {
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

export function fromContentRevisionRow(row: ContentRevisionRow): RagContentRevisionRecord {
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

export function fromChunkRow(row: ChunkRow): RagChunk {
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

export function mergeKnowledge(current: RagDocumentKnowledge, input: RagDocumentKnowledgeUpsert, now: string): RagDocumentKnowledge {
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

export function validateKnowledge(value: RagDocumentKnowledge): void {
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

export function validateStateError(state: string, error: RagPersistedError | null, label: string): void {
  if (state === 'failed' && error === null) throw new SqliteRagRepositoryError('RAG_ERROR_REQUIRED', `${label} is required for failed state`)
  if (state !== 'failed' && error !== null) throw new SqliteRagRepositoryError('RAG_ERROR_NOT_ALLOWED', `${label} is only allowed for failed state`)
}

export function normalizeChunk(chunk: RagChunk): RagChunk {
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

export function normalizeError(input: RagErrorInput | undefined, label: string): RagPersistedError | null {
  if (input === undefined || input === null) return null
  const code = validateText(input.code, `${label} code`, 128)
  const message = validateText(input.message, `${label} message`, 4 * 1024)
  const retryable = input.retryable ?? false
  const retryAfterMs = input.retryAfterMs == null ? null : validateInteger(input.retryAfterMs, 0, 86_400_000, `${label} retry delay`)
  return { code, message, retryable, retryAfterMs }
}

export function requireError(error: RagPersistedError | null, label: string): RagPersistedError {
  if (!error) throw new SqliteRagRepositoryError('RAG_ERROR_REQUIRED', `${label} is required for failed state`)
  return error
}

export function errorFromColumns(code: string | null, message: string | null, retryable: number | null, retryAfterMs: number | null): RagPersistedError | null {
  if (code === null && message === null) return null
  if (code === null || message === null) throw new SqliteRagRepositoryError('RAG_DATA_INVALID', 'Stored RAG error is incomplete')
  return { code, message, retryable: retryable === 1, retryAfterMs }
}

export function validateIdentifier(value: string, label: string, max = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\0')) {
    throw new SqliteRagRepositoryError('RAG_INVALID_INPUT', `Invalid ${label}`)
  }
  return value
}

export function validateText(value: string, label: string, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\0')) {
    throw new SqliteRagRepositoryError('RAG_INVALID_INPUT', `Invalid ${label}`)
  }
  return value
}

export function validateTimestamp(value: string, label: string): string {
  return validateText(value, label, 128)
}

export function validateInteger(value: number, min: number, max: number, label: string): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new SqliteRagRepositoryError('RAG_INVALID_INPUT', `Invalid ${label}`)
  return value
}

export function validateProgress(value: number): number {
  return validateInteger(value, 0, 100, 'progress')
}

export function validateNullableInteger(value: number | null, min: number, max: number, label: string): number | null {
  return value === null ? null : validateInteger(value, min, max, label)
}

export function validateEnum<T extends string>(value: T, allowed: readonly T[], label: string): T {
  if (!allowed.includes(value)) throw new SqliteRagRepositoryError('RAG_INVALID_INPUT', `Invalid ${label}`)
  return value
}

export function validateStringArray(value: readonly string[], label: string, maxItemLength: number): string[] {
  if (!Array.isArray(value) || value.length > 256) throw new SqliteRagRepositoryError('RAG_INVALID_INPUT', `Invalid ${label}`)
  return value.map((item) => validateText(item, label, maxItemLength))
}

export function parseStringArray(value: string, label: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) throw new Error('array required')
    return parsed as string[]
  } catch {
    throw new SqliteRagRepositoryError('RAG_DATA_INVALID', `Stored ${label} is invalid`)
  }
}

