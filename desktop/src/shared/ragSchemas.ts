import { z } from 'zod'

/**
 * RAG wire contracts are deliberately small.  In particular, these schemas
 * never carry document bodies, filesystem paths, SQL, provider URLs, API
 * keys, or JSON float vectors.  Large content and vectors belong to the
 * Utility-owned artifact/index stores and are addressed by opaque identities.
 */

export const RAG_MAX_SCOPE_DOCUMENT_IDS = 100
export const RAG_MAX_QUERY_CHARS = 2_000
export const RAG_MAX_ID_CHARS = 256
export const RAG_MAX_CURSOR_CHARS = 256
export const RAG_MAX_SECTION_DEPTH = 16
export const RAG_MAX_MAPPING_IDS = 64
export const RAG_MAX_RESULT_PAGE_ITEMS = 50
export const RAG_MAX_TOTAL_RESULTS = 100_000
export const RAG_MAX_EXCERPT_CHARS = 2_048
export const RAG_MAX_SELECTION_CHARS = 16_384
export const RAG_MAX_SELECTION_FRAGMENTS = 64
export const RAG_MAX_FRAGMENT_QUOTE_CHARS = 4_096
export const RAG_MAX_STREAM_DELTA_CHARS = 8_192
export const RAG_MAX_STREAM_EVENTS = 1_000_000
export const RAG_MAX_ERROR_MESSAGE_CHARS = 1_024
export const RAG_MAX_SERIALIZED_BYTES = 1_024 * 1_024
/** Alias used by callers that refer to the limit as a wire limit. */
export const MAX_RAG_WIRE_BYTES = RAG_MAX_SERIALIZED_BYTES

const noNul = (value: string): boolean => !value.includes('\0')
const noControlCharacters = (value: string): boolean => {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return false
  }
  return true
}

// User content can legitimately contain line breaks and tabs.  Keep the
// stricter control-character check for identifiers/cursors while still
// rejecting the characters that are unsafe or impossible to represent in a
// wire contract (NUL is checked separately for a useful error message).
const noUnsafeContentCharacters = (value: string): boolean => {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if ((code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) || (code >= 0x7f && code <= 0x9f)) return false
  }
  return true
}

const utf8ByteLength = (value: unknown): number => {
  let serialized: string
  try {
    serialized = JSON.stringify(value) as string
  } catch {
    return Number.POSITIVE_INFINITY
  }
  if (typeof serialized !== 'string') return Number.POSITIVE_INFINITY
  return new TextEncoder().encode(serialized).byteLength
}

export function ragWireByteLength(value: unknown): number {
  return utf8ByteLength(value)
}

export function isWithinRagWireLimit(value: unknown): boolean {
  return utf8ByteLength(value) <= RAG_MAX_SERIALIZED_BYTES
}

export function assertRagWireSize(value: unknown): void {
  if (!isWithinRagWireLimit(value)) throw new RangeError('RAG wire value exceeds 1 MiB')
}

function addWireLimitIssue(value: unknown, context: z.RefinementCtx): void {
  if (!isWithinRagWireLimit(value)) {
    context.addIssue({ code: 'custom', message: 'RAG wire value exceeds 1 MiB' })
  }
}

const boundedProgressSchema = z.number().int().min(0).max(100)
const boundedTimestampSchema = z.string().min(1).max(128).refine(noNul).refine(noControlCharacters)
const boundedIdSchema = z.string()
  .min(1)
  .max(RAG_MAX_ID_CHARS)
  .refine(noNul, 'ID cannot contain NUL')
  .refine(noControlCharacters, 'ID cannot contain control characters')
  .refine((value) => !value.includes('/') && !value.includes('\\'), 'ID cannot contain path separators')
const uuidSchema = z.string().uuid().refine(noNul).refine(noControlCharacters)
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/iu).refine(noNul)
const boundedCursorSchema = z.string()
  .min(1)
  .max(RAG_MAX_CURSOR_CHARS)
  .refine(noNul)
  .refine(noControlCharacters)
const boundedQuerySchema = z.string()
  .min(1)
  .max(RAG_MAX_QUERY_CHARS)
  .refine((value) => value.trim().length > 0, 'query cannot be blank')
  .refine(noNul, 'query cannot contain NUL')
  .refine(noUnsafeContentCharacters, 'query cannot contain unsafe control characters')
const boundedExcerptSchema = z.string()
  .min(1)
  .max(RAG_MAX_EXCERPT_CHARS)
  .refine(noNul, 'excerpt cannot contain NUL')
  .refine(noUnsafeContentCharacters, 'excerpt cannot contain unsafe control characters')
const boundedSectionSchema = z.string()
  .min(1)
  .max(512)
  .refine(noNul)
  .refine(noControlCharacters)

export const ragUuidSchema = uuidSchema
export const ragContentHashSchema = hashSchema
export const ragQuerySchema = boundedQuerySchema
export const ragCursorSchema = boundedCursorSchema
export const ragProgressSchema = boundedProgressSchema

// ---------------------------------------------------------------------------
// Independent knowledge states
// ---------------------------------------------------------------------------

export const localIndexStateSchema = z.enum([
  'unindexed',
  'queued',
  'indexing',
  'ready',
  'stale',
  'failed'
])
export type LocalIndexState = z.infer<typeof localIndexStateSchema>

export const semanticIndexStateSchema = z.enum([
  'disabled',
  'requires-consent',
  'requires-credential',
  'queued',
  'indexing',
  'ready',
  'stale',
  'failed'
])
export type SemanticIndexState = z.infer<typeof semanticIndexStateSchema>

export const chatAvailabilitySchema = z.enum(['disabled', 'requires-credential', 'ready'])
export type ChatAvailability = z.infer<typeof chatAvailabilitySchema>

/** Stable, user-safe error codes shared by status, search, and stream DTOs. */
export const ragErrorCodeSchema = z.enum([
  'RAG_NOT_INDEXED',
  'RAG_INDEX_STALE',
  'RAG_INVALID_STATE',
  'RAG_LIMIT_EXCEEDED',
  'SEMANTIC_CONSENT_REQUIRED',
  'EMBEDDING_CREDENTIALS_REQUIRED',
  'CHAT_CREDENTIALS_REQUIRED',
  'CHAT_CONSENT_REQUIRED',
  'CHAT_PROVIDER_REQUIRED',
  'CHAT_CREDENTIAL_UNVERIFIED',
  'CHAT_STORAGE_FAILED',
  'CONTENT_NOT_READY',
  'EMBEDDING_RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'EMBEDDING_PROFILE_MISMATCH',
  'VECTOR_INVALID',
  'RERANK_DEGRADED',
  'INSUFFICIENT_EVIDENCE',
  'CITATION_STALE',
  'CITATION_INVALID',
  'QUERY_SCOPE_INVALID',
  'SELECTION_STALE',
  'RAG_CANCELLED',
  'RAG_TIMEOUT',
  'RAG_SERIALIZATION_LIMIT'
])
export type RagErrorCode = z.infer<typeof ragErrorCodeSchema>
export const RAG_ERROR_CODES = ragErrorCodeSchema.options

export const ragErrorSchema = z.object({
  code: ragErrorCodeSchema,
  message: z.string().min(1).max(RAG_MAX_ERROR_MESSAGE_CHARS).refine(noNul).refine(noControlCharacters),
  retryable: z.boolean(),
  retryAfterMs: z.number().int().min(0).max(86_400_000).optional(),
  traceId: boundedIdSchema.optional()
}).strict()
export type RagError = z.infer<typeof ragErrorSchema>
export const knowledgeErrorSchema = ragErrorSchema

export const LOCAL_INDEX_STATE_TRANSITIONS: Readonly<Record<LocalIndexState, readonly LocalIndexState[]>> = Object.freeze({
  unindexed: ['queued', 'failed'],
  queued: ['indexing', 'failed'],
  indexing: ['queued', 'ready', 'failed'],
  ready: ['stale'],
  stale: ['queued', 'indexing', 'failed'],
  failed: ['queued']
})

export const SEMANTIC_INDEX_STATE_TRANSITIONS: Readonly<Record<SemanticIndexState, readonly SemanticIndexState[]>> = Object.freeze({
  disabled: ['requires-consent'],
  'requires-consent': ['disabled', 'requires-credential'],
  'requires-credential': ['disabled', 'requires-consent', 'queued'],
  queued: ['disabled', 'requires-consent', 'requires-credential', 'indexing', 'failed'],
  indexing: ['queued', 'ready', 'failed'],
  ready: ['stale', 'disabled'],
  stale: ['queued', 'indexing', 'failed', 'disabled', 'requires-consent', 'requires-credential'],
  failed: ['queued', 'disabled', 'requires-consent', 'requires-credential']
})

export const CHAT_AVAILABILITY_TRANSITIONS: Readonly<Record<ChatAvailability, readonly ChatAvailability[]>> = Object.freeze({
  disabled: ['requires-credential'],
  'requires-credential': ['disabled', 'ready'],
  ready: ['disabled', 'requires-credential']
})

function canTransition<T extends string>(
  transitions: Readonly<Record<T, readonly T[]>>,
  fromState: T | null,
  toState: T,
  initialState?: T
): boolean {
  if (fromState === toState) return true
  if (fromState === null) return initialState === toState
  return transitions[fromState]?.includes(toState) ?? false
}

export function canTransitionLocalIndexState(fromState: LocalIndexState | null, toState: LocalIndexState): boolean {
  return canTransition(LOCAL_INDEX_STATE_TRANSITIONS, fromState, toState, 'unindexed')
}

export function canTransitionSemanticIndexState(fromState: SemanticIndexState | null, toState: SemanticIndexState): boolean {
  return canTransition(SEMANTIC_INDEX_STATE_TRANSITIONS, fromState, toState, 'disabled')
}

export function canTransitionChatAvailability(fromState: ChatAvailability | null, toState: ChatAvailability): boolean {
  return canTransition(CHAT_AVAILABILITY_TRANSITIONS, fromState, toState, 'disabled')
}

// Short aliases make the state-machine API easy to discover without creating
// another source of truth.
export const canTransitionLocalState = canTransitionLocalIndexState
export const canTransitionSemanticState = canTransitionSemanticIndexState

export const localIndexStatusSchema = z.object({
  state: localIndexStateSchema,
  progress: boundedProgressSchema,
  activeContentRevisionId: boundedIdSchema.nullable(),
  error: ragErrorSchema.nullable()
}).strict().superRefine((value, context) => {
  if (value.state === 'unindexed' && value.activeContentRevisionId !== null) {
    context.addIssue({ code: 'custom', path: ['activeContentRevisionId'], message: 'unindexed cannot have an active content revision' })
  }
  if (value.state === 'ready' && (value.activeContentRevisionId === null || value.progress !== 100)) {
    context.addIssue({ code: 'custom', path: ['activeContentRevisionId'], message: 'ready requires an active content revision and 100% progress' })
  }
  if (value.state === 'failed' && value.error === null) {
    context.addIssue({ code: 'custom', path: ['error'], message: 'failed requires a retry-classified error' })
  }
  if (value.state !== 'failed' && value.error !== null) {
    context.addIssue({ code: 'custom', path: ['error'], message: 'only failed may expose an index error' })
  }
  addWireLimitIssue(value, context)
})
export type LocalIndexStatus = z.infer<typeof localIndexStatusSchema>

export const semanticIndexStatusSchema = z.object({
  state: semanticIndexStateSchema,
  progress: boundedProgressSchema,
  activeContentRevisionId: boundedIdSchema.nullable(),
  activeVectorIndexId: uuidSchema.nullable(),
  profileId: boundedIdSchema.nullable(),
  error: ragErrorSchema.nullable()
}).strict().superRefine((value, context) => {
  if (value.state === 'ready' && (
    value.activeContentRevisionId === null ||
    value.activeVectorIndexId === null ||
    value.profileId === null ||
    value.progress !== 100
  )) {
    context.addIssue({ code: 'custom', path: ['activeVectorIndexId'], message: 'ready requires active content/vector/profile identities and 100% progress' })
  }
  if (value.state === 'failed' && value.error === null) {
    context.addIssue({ code: 'custom', path: ['error'], message: 'failed requires a retry-classified error' })
  }
  if (value.state !== 'failed' && value.error !== null) {
    context.addIssue({ code: 'custom', path: ['error'], message: 'only failed may expose a semantic index error' })
  }
  if ((value.state === 'disabled' || value.state === 'requires-consent' || value.state === 'requires-credential') && (
    value.activeContentRevisionId !== null || value.activeVectorIndexId !== null || value.profileId !== null
  )) {
    context.addIssue({ code: 'custom', path: ['activeVectorIndexId'], message: 'disabled/consent/credential states cannot expose an active vector identity' })
  }
  addWireLimitIssue(value, context)
})
export type SemanticIndexStatus = z.infer<typeof semanticIndexStatusSchema>

export const knowledgeStatusSchema = z.object({
  local: localIndexStatusSchema,
  semantic: semanticIndexStatusSchema,
  chat: chatAvailabilitySchema,
  updatedAt: boundedTimestampSchema.optional()
}).strict().superRefine((value, context) => {
  if (
    value.local.activeContentRevisionId !== null &&
    value.semantic.activeContentRevisionId !== null &&
    value.semantic.activeContentRevisionId !== value.local.activeContentRevisionId
  ) {
    context.addIssue({ code: 'custom', path: ['semantic', 'activeContentRevisionId'], message: 'semantic index must identify the same active content revision' })
  }
  addWireLimitIssue(value, context)
})
export type KnowledgeStatus = z.infer<typeof knowledgeStatusSchema>

// ---------------------------------------------------------------------------
// Explicit scope
// ---------------------------------------------------------------------------

const currentDocumentScopeSchema = z.object({
  kind: z.literal('current-document'),
  documentId: uuidSchema
}).strict()

const documentsScopeSchema = z.object({
  kind: z.literal('documents'),
  documentIds: z.array(uuidSchema).min(1).max(RAG_MAX_SCOPE_DOCUMENT_IDS)
}).strict().superRefine((value, context) => {
  if (new Set(value.documentIds).size !== value.documentIds.length) {
    context.addIssue({ code: 'custom', path: ['documentIds'], message: 'documentIds must be unique' })
  }
})

const collectionScopeSchema = z.object({
  kind: z.literal('collection'),
  collectionId: uuidSchema
}).strict()

export const ragScopeSchema = z.discriminatedUnion('kind', [
  currentDocumentScopeSchema,
  documentsScopeSchema,
  collectionScopeSchema
]).superRefine(addWireLimitIssue)
export type RagScope = z.infer<typeof ragScopeSchema>
export const scopeSchema = ragScopeSchema
export { currentDocumentScopeSchema, documentsScopeSchema, collectionScopeSchema }

// ---------------------------------------------------------------------------
// Retrieval and pagination
// ---------------------------------------------------------------------------

export const scoreSourceSchema = z.enum(['lexical', 'dense', 'hybrid', 'selection', 'full-text'])
export type ScoreSource = z.infer<typeof scoreSourceSchema>

export const scoreProvenanceSchema = z.object({
  source: scoreSourceSchema,
  rank: z.number().int().min(1).max(RAG_MAX_TOTAL_RESULTS),
  score: z.number().finite().min(-1_000_000_000).max(1_000_000_000),
  algorithm: z.enum(['bm25', 'trigram', 'cosine', 'dot', 'rrf', 'rerank']).optional()
}).strict()
export type ScoreProvenance = z.infer<typeof scoreProvenanceSchema>

export const citationLocatorSchema = z.object({
  documentId: uuidSchema,
  artifactId: uuidSchema,
  contentRevisionId: boundedIdSchema,
  contentHash: hashSchema,
  mappingIds: z.array(boundedIdSchema).max(RAG_MAX_MAPPING_IDS),
  pageStart: z.number().int().min(0).max(100_000).nullable(),
  pageEnd: z.number().int().min(0).max(100_000).nullable(),
  sourceStartOffset: z.number().int().min(0).max(10_000_000).nullable(),
  sourceEndOffset: z.number().int().min(0).max(10_000_000).nullable(),
  offsetUnit: z.literal('utf16')
}).strict().superRefine((value, context) => {
  if (value.pageStart !== null && value.pageEnd !== null && value.pageEnd < value.pageStart) {
    context.addIssue({ code: 'custom', path: ['pageEnd'], message: 'pageEnd must not precede pageStart' })
  }
  if (value.sourceStartOffset !== null && value.sourceEndOffset !== null && value.sourceEndOffset < value.sourceStartOffset) {
    context.addIssue({ code: 'custom', path: ['sourceEndOffset'], message: 'sourceEndOffset must not precede sourceStartOffset' })
  }
  if (new Set(value.mappingIds).size !== value.mappingIds.length) {
    context.addIssue({ code: 'custom', path: ['mappingIds'], message: 'mappingIds must be unique' })
  }
  addWireLimitIssue(value, context)
})
export type CitationLocator = z.infer<typeof citationLocatorSchema>

export const searchResultItemSchema = z.object({
  resultId: boundedIdSchema.optional(),
  documentId: uuidSchema,
  contentRevisionId: boundedIdSchema,
  chunkId: boundedIdSchema,
  excerpt: boundedExcerptSchema,
  sectionPath: z.array(boundedSectionSchema).max(RAG_MAX_SECTION_DEPTH).optional(),
  contentType: z.enum(['paragraph', 'heading', 'table', 'formula', 'caption', 'code', 'list', 'other']).optional(),
  locator: citationLocatorSchema,
  scoreProvenance: z.array(scoreProvenanceSchema).min(1).max(8)
}).strict().superRefine((value, context) => {
  if (value.locator.documentId !== value.documentId || value.locator.contentRevisionId !== value.contentRevisionId) {
    context.addIssue({ code: 'custom', path: ['locator'], message: 'result locator identity must match result identity' })
  }
  addWireLimitIssue(value, context)
})
export type RagSearchResultItem = z.infer<typeof searchResultItemSchema>

const searchRequestFields = {
  scope: ragScopeSchema,
  query: boundedQuerySchema,
  limit: z.number().int().min(1).max(RAG_MAX_RESULT_PAGE_ITEMS),
  cursor: boundedCursorSchema.nullable().optional(),
  contentRevisionId: boundedIdSchema.nullable().optional()
}

export const lexicalSearchRequestSchema = z.object({
  kind: z.literal('lexical'),
  ...searchRequestFields,
  includeTranslated: z.boolean().optional()
}).strict().superRefine(addWireLimitIssue)
export type LexicalSearchRequest = z.infer<typeof lexicalSearchRequestSchema>

export const denseSearchRequestSchema = z.object({
  kind: z.literal('dense'),
  ...searchRequestFields,
  profileId: boundedIdSchema.optional()
}).strict().superRefine(addWireLimitIssue)
export type DenseSearchRequest = z.infer<typeof denseSearchRequestSchema>

export const hybridSearchRequestSchema = z.object({
  kind: z.literal('hybrid'),
  ...searchRequestFields,
  profileId: boundedIdSchema.optional(),
  allowSemanticDegradation: z.boolean().optional()
}).strict().superRefine(addWireLimitIssue)
export type HybridSearchRequest = z.infer<typeof hybridSearchRequestSchema>

export const ragSearchRequestSchema = z.discriminatedUnion('kind', [
  lexicalSearchRequestSchema,
  denseSearchRequestSchema,
  hybridSearchRequestSchema
]).superRefine(addWireLimitIssue)
export type RagSearchRequest = z.infer<typeof ragSearchRequestSchema>
export const searchRequestSchema = ragSearchRequestSchema

export const lexicalSearchResultSchema = z.object({
  kind: z.literal('lexical'),
  items: z.array(searchResultItemSchema).max(RAG_MAX_RESULT_PAGE_ITEMS),
  nextCursor: boundedCursorSchema.nullable(),
  total: z.number().int().min(0).max(RAG_MAX_TOTAL_RESULTS)
}).strict().superRefine((value, context) => {
  const resultIds = value.items.flatMap((item) => item.resultId === undefined ? [] : [item.resultId])
  if (new Set(resultIds).size !== resultIds.length) context.addIssue({ code: 'custom', path: ['items'], message: 'resultId values must be unique' })
  addWireLimitIssue(value, context)
})
export type LexicalSearchResult = z.infer<typeof lexicalSearchResultSchema>
export type LexicalSearchResultPage = LexicalSearchResult

export const denseSearchResultSchema = z.object({
  kind: z.literal('dense'),
  items: z.array(searchResultItemSchema).max(RAG_MAX_RESULT_PAGE_ITEMS),
  nextCursor: boundedCursorSchema.nullable(),
  total: z.number().int().min(0).max(RAG_MAX_TOTAL_RESULTS)
}).strict().superRefine((value, context) => {
  const resultIds = value.items.flatMap((item) => item.resultId === undefined ? [] : [item.resultId])
  if (new Set(resultIds).size !== resultIds.length) context.addIssue({ code: 'custom', path: ['items'], message: 'resultId values must be unique' })
  addWireLimitIssue(value, context)
})
export type DenseSearchResult = z.infer<typeof denseSearchResultSchema>
export type DenseSearchResultPage = DenseSearchResult

export const hybridSearchResultSchema = z.object({
  kind: z.literal('hybrid'),
  items: z.array(searchResultItemSchema).max(RAG_MAX_RESULT_PAGE_ITEMS),
  nextCursor: boundedCursorSchema.nullable(),
  total: z.number().int().min(0).max(RAG_MAX_TOTAL_RESULTS),
  degraded: z.boolean().optional()
}).strict().superRefine((value, context) => {
  const resultIds = value.items.flatMap((item) => item.resultId === undefined ? [] : [item.resultId])
  if (new Set(resultIds).size !== resultIds.length) context.addIssue({ code: 'custom', path: ['items'], message: 'resultId values must be unique' })
  addWireLimitIssue(value, context)
})
export type HybridSearchResult = z.infer<typeof hybridSearchResultSchema>
export type HybridSearchResultPage = HybridSearchResult

export const ragSearchResultPageSchema = z.discriminatedUnion('kind', [
  lexicalSearchResultSchema,
  denseSearchResultSchema,
  hybridSearchResultSchema
]).superRefine(addWireLimitIssue)
export type RagSearchResultPage = z.infer<typeof ragSearchResultPageSchema>
export const searchResultPageSchema = ragSearchResultPageSchema

export const citationSchema = z.object({
  citationId: uuidSchema,
  evidenceId: z.string().regex(/^E[1-9]\d{0,3}$/u).optional(),
  documentId: uuidSchema,
  chunkId: boundedIdSchema,
  excerpt: boundedExcerptSchema,
  locator: citationLocatorSchema,
  scoreProvenance: z.array(scoreProvenanceSchema).min(1).max(8)
}).strict().superRefine((value, context) => {
  if (value.locator.documentId !== value.documentId) context.addIssue({ code: 'custom', path: ['locator'], message: 'citation locator document mismatch' })
  if (value.locator.contentRevisionId.length === 0 || value.locator.contentHash.length === 0) {
    context.addIssue({ code: 'custom', path: ['locator'], message: 'citation must retain revision and hash' })
  }
  addWireLimitIssue(value, context)
})
export type Citation = z.infer<typeof citationSchema>

// ---------------------------------------------------------------------------
// Selection snapshots
// ---------------------------------------------------------------------------

export const selectionSnapshotSchema = z.object({
  artifactId: uuidSchema,
  contentRevisionId: boundedIdSchema,
  contentHash: hashSchema
}).strict()
export type SelectionSnapshot = z.infer<typeof selectionSnapshotSchema>
export const artifactContentSnapshotSchema = selectionSnapshotSchema

export const selectionFragmentSchema = z.object({
  mappingIds: z.array(boundedIdSchema).max(RAG_MAX_MAPPING_IDS),
  startOffset: z.number().int().min(0).max(10_000_000),
  endOffset: z.number().int().min(1).max(10_000_000),
  quote: z.string().min(1).max(RAG_MAX_FRAGMENT_QUOTE_CHARS).refine(noNul).refine(noUnsafeContentCharacters),
  pageIndex: z.number().int().min(0).max(100_000).nullable().optional()
}).strict().superRefine((value, context) => {
  if (value.endOffset <= value.startOffset) context.addIssue({ code: 'custom', path: ['endOffset'], message: 'endOffset must exceed startOffset' })
  if (new Set(value.mappingIds).size !== value.mappingIds.length) context.addIssue({ code: 'custom', path: ['mappingIds'], message: 'mappingIds must be unique' })
})
export type SelectionFragment = z.infer<typeof selectionFragmentSchema>
export const selectionFragmentSchemaExport = selectionFragmentSchema

const selectionRequestCommon = {
  documentId: uuidSchema,
  scope: ragScopeSchema,
  view: z.enum(['original', 'translated']),
  text: z.string().min(1).max(RAG_MAX_SELECTION_CHARS).refine(noNul).refine(noControlCharacters),
  fragments: z.array(selectionFragmentSchema).min(1).max(RAG_MAX_SELECTION_FRAGMENTS),
  question: boundedQuerySchema.optional()
}

const selectionRequestWithSnapshotSchema = z.object({
  ...selectionRequestCommon,
  snapshot: selectionSnapshotSchema
}).strict().superRefine((value, context) => {
  if (value.scope.kind === 'current-document' && value.scope.documentId !== value.documentId) {
    context.addIssue({ code: 'custom', path: ['scope', 'documentId'], message: 'selection scope document mismatch' })
  }
  addWireLimitIssue(value, context)
})

export const selectionRequestSchema = selectionRequestWithSnapshotSchema
export type SelectionRequest = z.infer<typeof selectionRequestSchema>
export const readerSelectionRequestSchema = selectionRequestSchema

// ---------------------------------------------------------------------------
// Bounded answer stream
// ---------------------------------------------------------------------------

const streamCommon = {
  requestId: uuidSchema,
  sequence: z.number().int().min(0).max(RAG_MAX_STREAM_EVENTS),
  conversationId: uuidSchema.optional()
}
const streamAcceptedSchema = z.object({ ...streamCommon, type: z.literal('accepted') }).strict()
const streamRetrievingSchema = z.object({ ...streamCommon, type: z.literal('retrieving'), progress: boundedProgressSchema.optional() }).strict()
const streamEvidenceReadySchema = z.object({
  ...streamCommon,
  type: z.literal('evidence-ready'),
  resultCount: z.number().int().min(0).max(RAG_MAX_TOTAL_RESULTS)
}).strict()
const streamDeltaSchema = z.object({
  ...streamCommon,
  type: z.literal('delta'),
  delta: z.string().min(1).max(RAG_MAX_STREAM_DELTA_CHARS).refine(noNul).refine(noUnsafeContentCharacters)
}).strict()
const streamCitationSchema = z.object({
  ...streamCommon,
  type: z.literal('citation'),
  citation: citationSchema
}).strict()
const streamCompletedSchema = z.object({
  ...streamCommon,
  type: z.literal('completed'),
  answer: z.string().max(32_768).refine(noNul).refine(noUnsafeContentCharacters).optional(),
  citationIds: z.array(uuidSchema).max(RAG_MAX_RESULT_PAGE_ITEMS).optional()
}).strict()
const streamFailedSchema = z.object({ ...streamCommon, type: z.literal('failed'), error: ragErrorSchema }).strict()
const streamCancelledSchema = z.object({
  ...streamCommon,
  type: z.literal('cancelled'),
  reason: z.string().max(512).refine(noNul).refine(noUnsafeContentCharacters).optional()
}).strict()

export const ragStreamEventSchema = z.discriminatedUnion('type', [
  streamAcceptedSchema,
  streamRetrievingSchema,
  streamEvidenceReadySchema,
  streamDeltaSchema,
  streamCitationSchema,
  streamCompletedSchema,
  streamFailedSchema,
  streamCancelledSchema
]).superRefine(addWireLimitIssue)
export type RagStreamEvent = z.infer<typeof ragStreamEventSchema>
export const chatStreamEventSchema = ragStreamEventSchema

export type RagStreamEventType = RagStreamEvent['type']
export const RAG_STREAM_EVENT_TRANSITIONS: Readonly<Record<RagStreamEventType, readonly RagStreamEventType[]>> = Object.freeze({
  accepted: ['retrieving', 'failed', 'cancelled'],
  retrieving: ['retrieving', 'evidence-ready', 'failed', 'cancelled'],
  'evidence-ready': ['delta', 'citation', 'completed', 'failed', 'cancelled'],
  delta: ['delta', 'citation', 'completed', 'failed', 'cancelled'],
  citation: ['delta', 'citation', 'completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: []
})

export function canTransitionRagStreamEvent(fromType: RagStreamEventType | null, toType: RagStreamEventType): boolean {
  if (fromType === toType && (toType === 'retrieving' || toType === 'delta' || toType === 'citation')) return true
  if (fromType === null) return toType === 'accepted'
  return RAG_STREAM_EVENT_TRANSITIONS[fromType].includes(toType)
}

// Friendly aliases for callers that use “chat” terminology.
export const canTransitionChatStreamEvent = canTransitionRagStreamEvent
