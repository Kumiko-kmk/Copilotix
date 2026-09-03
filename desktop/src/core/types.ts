export type JsonObject = Record<string, unknown>

export type DocumentId = string
export type DocumentParserModel = 'vlm' | 'pipeline'
export type DocumentTranslationProvider = 'qwen' | 'deepseek' | 'bing' | 'transmart'

export interface Document {
  id: DocumentId
  originalFilename: string
  displayTitle: string | null
  storagePath: string
  sourceChecksum: string
  parserModel: DocumentParserModel
  translationProvider: DocumentTranslationProvider
  createdAt: string
  updatedAt: string
}

export type JobKind = 'parse' | 'translate'
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
