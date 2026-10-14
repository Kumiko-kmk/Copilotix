import { z } from 'zod'
import { chatResultMetadataSchema } from './chatResultMetadata'

/**
 * Wire contracts for the single-paper chat: answer stream, citations,
 * selection fragments and the local chat-index state.  (The "rag" prefix is
 * historical; multi-document search/embedding contracts were removed with the
 * abandoned RAG plan.)  These schemas never carry document bodies,
 * filesystem paths, SQL, provider URLs or API keys.
 */

export const RAG_MAX_QUERY_CHARS = 2_000
export const RAG_MAX_ID_CHARS = 256
export const RAG_MAX_MAPPING_IDS = 64
export const RAG_MAX_RESULT_PAGE_ITEMS = 50
export const RAG_MAX_TOTAL_RESULTS = 100_000
export const RAG_MAX_EXCERPT_CHARS = 2_048
export const RAG_MAX_FRAGMENT_QUOTE_CHARS = 4_096
export const RAG_MAX_STREAM_DELTA_CHARS = 8_192
export const RAG_MAX_STREAM_EVENTS = 1_000_000
export const RAG_MAX_ERROR_MESSAGE_CHARS = 1_024
export const RAG_MAX_SERIALIZED_BYTES = 1_024 * 1_024

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

function addWireLimitIssue(value: unknown, context: z.RefinementCtx): void {
  if (!isWithinRagWireLimit(value)) {
    context.addIssue({ code: 'custom', message: 'RAG wire value exceeds 1 MiB' })
  }
}

const boundedProgressSchema = z.number().int().min(0).max(100)
const boundedIdSchema = z.string()
  .min(1)
  .max(RAG_MAX_ID_CHARS)
  .refine(noNul, 'ID cannot contain NUL')
  .refine(noControlCharacters, 'ID cannot contain control characters')
  .refine((value) => !value.includes('/') && !value.includes('\\'), 'ID cannot contain path separators')
const uuidSchema = z.string().uuid().refine(noNul).refine(noControlCharacters)
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/iu).refine(noNul)
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

export const ragUuidSchema = uuidSchema
export const ragQuerySchema = boundedQuerySchema

// ---------------------------------------------------------------------------
// Local chat-index state (persisted in rag_documents)
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

/** Columns of the abandoned semantic index; kept only to type persisted rows. */
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

/** Stable, user-safe error codes.  Stored chat turns may hold any value, so the list is kept whole. */
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

export const ragErrorSchema = z.object({
  code: ragErrorCodeSchema,
  message: z.string().min(1).max(RAG_MAX_ERROR_MESSAGE_CHARS).refine(noNul).refine(noControlCharacters),
  retryable: z.boolean(),
  retryAfterMs: z.number().int().min(0).max(86_400_000).optional(),
  traceId: boundedIdSchema.optional()
}).strict()

// ---------------------------------------------------------------------------
// Citations
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
// Reader selection fragments
// ---------------------------------------------------------------------------

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
  metadata: chatResultMetadataSchema.optional(),
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
