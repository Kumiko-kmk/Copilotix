import { type DocumentId } from '@features/library/contract/artifacts'

/** Translation batch commits written by the Utility repository. */

export type DocumentTranslationProvider = 'qwen' | 'deepseek' | 'bing' | 'transmart' | 'codex'

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
