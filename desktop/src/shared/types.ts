import type { PaperChatAskRequest, PaperChatStatus } from './paperChatSchemas'
import type { PaperChatLoadRequest, PaperChatPage, PaperChatSession } from './paperChatStorageSchemas'
import type { RagStreamEvent } from './ragSchemas'
import type { LibraryRequest, LibraryResult } from './librarySchemas'
import type {
  DeleteDocumentRequest,
  DocumentChangeEvent,
  DocumentDetails,
  DocumentSummary,
  ImportDocumentsRequest,
  ImportDocumentsResult,
  ListReaderAnnotationsRequest,
  MutateReaderAnnotationsRequest,
  ReaderAnnotationSnapshot,
  SaveDocumentAsRequest,
  SaveDocumentAsResult,
  StorageInfo,
  UsageAnalytics
} from './ipcSchemas'

export type TranslationProviderId = 'qwen' | 'deepseek' | 'bing' | 'transmart'

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
  chatProvider: 'qwen' | 'deepseek' | null
  qwenChatModel: string
  deepseekChatModel: string
  chatConsentProvider: 'qwen' | 'deepseek' | null
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
  pdfUrl: string
  assetBaseUrl: string
}

export interface TranslatedMarkdownBlock {
  sourceIndex?: number
  markdown: string
  mappingIds: string[]
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

export interface CopilotixDesktopApi {
  paperChat: {
    load(request: PaperChatLoadRequest): Promise<PaperChatPage>
    session(request: { documentId: string }): Promise<PaperChatSession>
    saveSession(request: { documentId: string; session: PaperChatSession }): Promise<{ saved: true }>
    clear(request: { documentId: string }): Promise<{ cleared: true }>
    ask(request: PaperChatAskRequest): Promise<{ requestId: string }>
    cancel(request: { requestId: string }): Promise<{ cancelled: boolean }>
    ensureIndex(request: { documentId: string }): Promise<PaperChatStatus>
    onEvent(listener: (event: RagStreamEvent) => void): () => void
  }
  manageLibrary(request: LibraryRequest): Promise<LibraryResult>
  getSettings(): Promise<AppSettings>
  saveSettings(update: SettingsUpdate): Promise<SettingsSaveResult>
  validateCredential(name: CredentialName, value?: string): Promise<CredentialValidationResult>
  chooseOutputDirectory(): Promise<string | null>
  getStorageInfo(): Promise<StorageInfo>
  getUsageAnalytics(): Promise<UsageAnalytics>
  openStorageLocation(): Promise<void>
  importDocuments(request: ImportDocumentsRequest, droppedFiles?: File[]): Promise<ImportDocumentsResult>
  importTutorialPaper(createDuplicate?: boolean): Promise<DocumentSummary | null>
  listDocuments(): Promise<DocumentSummary[]>
  retryDocument(documentId: string): Promise<void>
  deleteDocument(request: DeleteDocumentRequest): Promise<void>
  getDocument(documentId: string): Promise<DocumentDetails>
  openDocumentOutput(documentId: string): Promise<void>
  saveDocumentAs(request: SaveDocumentAsRequest): Promise<SaveDocumentAsResult>
  listReaderAnnotations(request: ListReaderAnnotationsRequest): Promise<ReaderAnnotationSnapshot>
  mutateReaderAnnotations(request: MutateReaderAnnotationsRequest): Promise<ReaderAnnotationSnapshot>
  performWindowAction(action: WindowAction): Promise<WindowState>
  getWindowState(): Promise<WindowState>
  onDocumentsChanged(listener: (event: DocumentChangeEvent) => void): () => void
  onOpenDocument(listener: (documentId: string) => void): () => void
  onWindowStateChanged(listener: (state: WindowState) => void): () => void
}

declare global {
  interface Window {
    copilotix: CopilotixDesktopApi
  }
}
