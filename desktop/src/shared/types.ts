import type { ResolvedMarkdownEdits } from '@features/reader/contract/markdownEdits'

export type TranslationProviderId = 'qwen' | 'deepseek' | 'bing' | 'transmart' | 'codex'

export type CredentialName = 'parser' | 'qwen' | 'deepseek'

export type CredentialValidation = 'missing' | 'unknown' | 'valid' | 'invalid'

export type CredentialMutation =
  | { action: 'set'; value: string }
  | { action: 'clear' }

export interface CredentialValidationResult {
  state: CredentialValidation
  errorCode?: string
  message?: string
}

export interface CredentialStatus extends CredentialValidationResult {
  maskedValue?: string
}

export interface CredentialStatuses {
  parser: CredentialStatus
  qwen: CredentialStatus
  deepseek: CredentialStatus
}

export interface CredentialFieldError {
  code: string
  message: string
}

export type TaskStatus =
  | 'uploading'
  | 'parsing'
  | 'translating'
  | 'partial'
  | 'completed'
  | 'failed'

export interface AppSettings {
  codex?: import('@platform/codex/contract/codex').CodexSettings
  outputRoot: string
  formulaEnabled: boolean
  tableEnabled: boolean
  translationProvider: TranslationProviderId
  translationProviderOrder: TranslationProviderId[]
  enabledTranslationProviders: TranslationProviderId[]
  qwenBaseUrl: string
  qwenModel: string
  deepseekBaseUrl: string
  deepseekModel: string
  /** Legacy persisted field, ignored by chat routing; use translationProvider. */
  chatProvider: 'qwen' | 'deepseek' | 'codex' | null
  autoGeneratePaperInsight: boolean
  qwenChatModel: string
  deepseekChatModel: string
  chatConsentProvider: 'qwen' | 'deepseek' | 'codex' | null
  chatConsentVersion: number | null
  credentials: CredentialStatuses
}

export interface SettingsUpdate
  extends Omit<AppSettings, 'credentials'> {
  credentialMutations?: Partial<Record<CredentialName, CredentialMutation>>
}

export interface SettingsSaveResult {
  settings: AppSettings
  fieldErrors: Partial<Record<CredentialName, CredentialFieldError>>
}

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

export interface BlockBox {
  pageIndex: number
  bbox: [number, number, number, number]
  pageSize: [number, number]
  blockPosition: string
  isDiscarded?: boolean
  mergeRole?: 'source' | 'continuation'
}

export interface BlockMapping {
  id: string
  order: number
  type: string
  sourceText: string
  sourceAsset?: string
  boxes: BlockBox[]
}

export type BlockSelectionOrigin = 'pdf' | 'markdown' | 'scroll' | 'citation'

export interface BlockSelection {
  mappingId: string
  blockPosition?: string
  origin: BlockSelectionOrigin
}

export type ReaderAnnotationView = 'original' | 'translated'
export type ReaderAnnotationKind = 'highlight' | 'underline'
export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink' | 'purple'

export interface ReaderAnnotation {
  id: string
  taskId: string
  view: ReaderAnnotationView
  kind: ReaderAnnotationKind
  color: HighlightColor | null
  blockKey: string
  startOffset: number
  endOffset: number
  quote: string
  prefix: string
  suffix: string
  createdAt: string
  updatedAt: string
}

export interface ReplaceReaderAnnotationsRequest {
  taskId: string
  view: ReaderAnnotationView
  annotations: ReaderAnnotation[]
}

export interface ReaderChatSelectionFragment {
  blockKey: string
  startOffset: number
  endOffset: number
  quote: string
  mappingIds: string[]
  pageIndex?: number
}

export interface ReaderChatSelection {
  taskId: string
  view: ReaderAnnotationView
  text: string
  fragments: ReaderChatSelectionFragment[]
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

export type WindowAction = 'minimize' | 'toggle-maximize' | 'close'

export interface WindowState {
  maximized: boolean
}
