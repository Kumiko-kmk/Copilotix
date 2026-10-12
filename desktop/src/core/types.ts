import type { CitationLocator } from '@shared/ragSchemas'

export type JsonObject = Record<string, unknown>

export type DocumentId = string
export type DocumentTranslationProvider = 'qwen' | 'deepseek' | 'bing' | 'transmart'

/**
 * Durable work kinds.  The chat index job shares the job table and state
 * machine with the foreground document jobs; it is not projected into
 * DocumentWorkflowStatus.  `rag-embed`/`rag-delete` belong to the abandoned
 * semantic-index plan and stay only because the jobs table CHECK constraint
 * still allows them.
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
export type RagChunkContentType = 'paragraph' | 'heading' | 'table' | 'formula' | 'caption' | 'code' | 'list' | 'other'
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
