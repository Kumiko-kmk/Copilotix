import type { CitationLocator } from '@features/chat/contract/ragSchemas'

export type DocumentId = string
export type DocumentTranslationProvider = 'qwen' | 'deepseek' | 'bing' | 'transmart' | 'codex'


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
