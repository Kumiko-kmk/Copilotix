import type { CitationLocator } from './ragSchemas'

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
