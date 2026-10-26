
/** Translation provider ids and translated block records shared by the translation pipeline and its readers. */

export type TranslationProviderId = 'qwen' | 'deepseek' | 'bing' | 'transmart' | 'codex'

export interface TranslatedMarkdownBlock {
  sourceIndex?: number
  markdown: string
  mappingIds: string[]
  /** Provider that translated this block when it differs from the job's preferred provider. */
  fallbackProvider?: TranslationProviderId
  /** sha256 of the source block it was translated from (manifests since translation pipeline v6). */
  sourceHash?: string
  /** The source block changed after translation (e.g. a text-layer repair); a retry re-translates it. */
  sourceChanged?: true
}

export interface TranslationBlockRecord {
  taskId: string
  /** Durable translate job owning this block; omitted only by legacy adapters. */
  jobId?: string
  blockId: string
  sourceHash: string
  sourceMarkdown: string
  translatedMarkdown: string | null
  provider: TranslationProviderId | null
  model: string | null
  status: 'pending' | 'completed' | 'failed'
  error: string | null
}
