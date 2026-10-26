import type { ResolvedMarkdownEdits } from '@features/reader/contract/markdownEdits'
import { type TranslationProviderId, type TranslatedMarkdownBlock } from '@features/translation/contract/translationTypes'
import { type BlockMapping } from '@features/parsing/contract/blocks'

/** Library tasks (documents) and the document payload the reader opens. */

export type TaskStatus =
  | 'uploading'
  | 'parsing'
  | 'translating'
  | 'partial'
  | 'completed'
  | 'failed'

export interface CopilotixTask {
  id: string
  /** Filename selected by the user; never changed after task creation. */
  originalName: string
  /** Sanitized English paper title without a file extension, when available. */
  title: string | null
  /**
   * Set only when a task is created with a title read from the PDF's own metadata. The parse job
   * keeps it so the parsed title can replace that provisional title; reads never return it.
   */
  titleSource?: 'pdf-metadata'
  name: string
  sourcePath: string
  sourceHash: string
  outputDir: string
  status: TaskStatus
  progress: number
  translationProvider: TranslationProviderId
  remoteBatchId: string | null
  remoteDataId: string | null
  remoteResultUrl: string | null
  error: string | null
  createdAt: string
  updatedAt: string
}

export interface HealthResult {
  ok: boolean
  message: string
  code?: string | number
  traceId?: string
}

export interface DocumentPayload {
  task: CopilotixTask
  markdown: string
  translatedMarkdown: string
  translatedBlocks: TranslatedMarkdownBlock[] | null
  layoutJson: string
  mappings: BlockMapping[]
  /** The user's edit layer resolved against this text; null when its file cannot be read. */
  markdownEdits?: ResolvedMarkdownEdits | null
  pdfUrl: string
  assetBaseUrl: string
}
