import type { CitationLocator, RagSearchResultItem, SelectionRequest } from '@shared/ragTypes'

export type JsonObject = Record<string, unknown>

export type DocumentId = string
export type DocumentTranslationProvider = 'qwen' | 'deepseek' | 'bing' | 'transmart'

export interface Document {
  id: DocumentId
  originalFilename: string
  displayTitle: string | null
  storagePath: string
  sourceChecksum: string
  translationProvider: DocumentTranslationProvider
  createdAt: string
  updatedAt: string
}

/**
 * Durable work kinds.  RAG jobs deliberately share the same job table and
 * state machine as the foreground document jobs; they are not projected into
 * DocumentWorkflowStatus.
 */
export type JobKind = 'parse' | 'translate' | 'rag-content-index' | 'rag-embed' | 'rag-delete'
export type JobStatus = 'queued' | 'running' | 'retry-wait' | 'succeeded' | 'partial' | 'failed' | 'cancelled'

export interface Job {
  id: string
  documentId: DocumentId
  kind: JobKind
  status: JobStatus
  progress: number
  dependsOnJobId: string | null
  priority: number
  attempt: number
  maxAttempts: number
  payload: JsonObject
  checkpoint: JsonObject
  availableAt: string
  leaseOwner: string | null
  leaseExpiresAt: string | null
  errorCode: string | null
  errorMessage: string | null
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface JobEvent {
  id: string
  jobId: string
  sequence: number
  fromState: JobStatus | null
  toState: JobStatus
  detail: JsonObject
  createdAt: string
}

export type ArtifactKind =
  | 'source_pdf'
  | 'parsed_markdown'
  | 'layout'
  | 'block_mappings'
  | 'content_list'
  | 'translated_markdown'
  | 'manifest'

export interface ArtifactRevision {
  id: string
  documentId: DocumentId
  kind: ArtifactKind
  revision: number
  relativePath: string
  contentHash: string
  createdByJobId: string | null
  metadata: JsonObject
  createdAt: string
}

export interface TranslationBlock {
  jobId: string
  blockId: string
  sourceHash: string
  sourceMarkdown: string
  translatedMarkdown: string | null
  provider: DocumentTranslationProvider | null
  model: string | null
  status: 'pending' | 'completed' | 'failed'
  error: string | null
}

export interface TranslationBatchBlock {
  blockId: string
  sourceHash: string
  sourceMarkdown: string
  translatedMarkdown: string | null
  provider: DocumentTranslationProvider | null
  model: string | null
  status: 'pending' | 'completed' | 'failed'
  error: string | null
}

export interface TranslationCacheEntry {
  cacheKey: string
  translated: string
  provider: DocumentTranslationProvider
  model: string
}

export interface TranslationCheckpointSummary {
  totalBlocks: number
  completedBlocks: number
  failedBlocks: number
  failedBlockIds: string[]
}

export interface TranslationBatchCommit {
  taskId: DocumentId
  jobId: string
  blocks: TranslationBatchBlock[]
  cacheEntries: TranslationCacheEntry[]
  checkpoint?: TranslationCheckpointSummary
}

/**
 * Canonical source chunk held by the Utility-owned index.  This is an
 * internal data shape, not a wire DTO; source text and provenance stay out of
 * Renderer-facing contracts until a bounded result is produced.
 */
export type RagChunkContentType = NonNullable<RagSearchResultItem['contentType']>
export type RagMappingConfidence = 'exact' | 'range' | 'media' | 'fallback' | 'none'

export interface RagChunk {
  chunkId: string
  contentRevisionId: string
  ordinal: number
  contentHash: string
  sourceText: string
  sectionPath: readonly string[]
  mappingIds: readonly string[]
  pageStart: number | null
  pageEnd: number | null
  sourceStartOffset: number | null
  sourceEndOffset: number | null
  offsetUnit: CitationLocator['offsetUnit']
  tokenCount: number
  contentType: RagChunkContentType
  mappingConfidence: RagMappingConfidence
}

/** Input consumed by a deterministic chunker after an artifact is validated. */
export interface RagChunkInput {
  documentId: DocumentId
  artifactId: string
  contentRevisionId: string
  contentHash: string
  sourceText: string
}

/**
 * Internal vector entry used between Utility-owned indexing components.
 * `Float32Array` is intentional: JSON float vectors are never wire data.
 */
export interface RagVectorEntry {
  vectorIndexId: string
  contentRevisionId: string
  profileId: string
  chunkId: string
  vector: Float32Array
}

/** Utility-only dense query; wire requests are translated before this layer. */
export interface RagVectorSearchInput {
  vectorIndexId: string
  contentRevisionId: string
  profileId: string
  queryVector: Float32Array
  limit: number
}

export interface RagVectorSearchCandidate {
  chunkId: string
  rank: number
  score: number
}

/** Bounded candidate metadata returned by the Utility vector store. */
export interface RagVectorSearchResult {
  candidates: readonly RagVectorSearchCandidate[]
}

export interface RagCitationResolutionInput {
  candidates: readonly RagSearchResultItem[]
  selection?: SelectionRequest
}
