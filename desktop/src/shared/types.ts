export type ParserModel = 'vlm' | 'pipeline'
export type TranslationProviderId = 'qwen' | 'deepseek' | 'bing' | 'transmart'

export type TaskStatus =
  | 'uploading'
  | 'parsing'
  | 'translating'
  | 'partial'
  | 'completed'
  | 'failed'

export interface AppSettings {
  hasParserToken: boolean
  outputRoot: string
  parserModel: ParserModel
  forceOcr: boolean
  formulaEnabled: boolean
  tableEnabled: boolean
  ocrLanguage: string
  translationProvider: TranslationProviderId
  qwenBaseUrl: string
  qwenModel: string
  qwenHasApiKey: boolean
  deepseekBaseUrl: string
  deepseekModel: string
  deepseekHasApiKey: boolean
}

export interface SettingsUpdate
  extends Omit<AppSettings, 'hasParserToken' | 'qwenHasApiKey' | 'deepseekHasApiKey'> {
  parserToken?: string
  clearParserToken?: boolean
  qwenApiKey?: string
  clearQwenApiKey?: boolean
  deepseekApiKey?: string
  clearDeepseekApiKey?: boolean
}

export interface MinerUTask {
  id: string
  name: string
  sourcePath: string
  sourceHash: string
  outputDir: string
  status: TaskStatus
  progress: number
  parserModel: ParserModel
  translationProvider: TranslationProviderId
  remoteBatchId: string | null
  remoteDataId: string | null
  remoteResultUrl: string | null
  error: string | null
  createdAt: string
  updatedAt: string
}

export interface SelectedPdf {
  path: string
  name: string
  size: number
  duplicateTask?: MinerUTask
}

export interface CreateTasksRequest {
  files: SelectedPdf[]
  parserModel: ParserModel
  translationProvider: TranslationProviderId
  createDuplicates?: boolean
}

export interface DeleteTaskRequest {
  taskId: string
  deleteFiles: boolean
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

export type BlockSelectionOrigin = 'pdf' | 'markdown' | 'scroll'

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
  task: MinerUTask
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

export interface TranslationCheckpoint {
  taskId: string
  totalBlocks: number
  completedBlocks: number
  failedBlockIds: string[]
  updatedAt: string
}

export interface TranslationBlockRecord {
  taskId: string
  blockId: string
  sourceHash: string
  sourceMarkdown: string
  translatedMarkdown: string | null
  provider: TranslationProviderId | null
  model: string | null
  status: 'pending' | 'completed' | 'failed'
  error: string | null
}

export interface SaveAsRequest {
  taskId: string
  kind: 'original-markdown' | 'translated-markdown' | 'result-zip'
}

export type WindowAction = 'minimize' | 'toggle-maximize' | 'close'

export interface WindowState {
  maximized: boolean
}

export interface MinerUDesktopApi {
  getSettings(): Promise<AppSettings>
  saveSettings(update: SettingsUpdate): Promise<AppSettings>
  testParserConnection(parserToken?: string): Promise<HealthResult>
  testTranslationProvider(provider: TranslationProviderId): Promise<HealthResult>
  chooseOutputDirectory(): Promise<string | null>
  choosePdfs(): Promise<SelectedPdf[]>
  inspectDroppedPdfs(files: File[]): Promise<SelectedPdf[]>
  createTasks(request: CreateTasksRequest): Promise<MinerUTask[]>
  listTasks(): Promise<MinerUTask[]>
  deleteTask(request: DeleteTaskRequest): Promise<void>
  retryTask(taskId: string): Promise<void>
  getDocument(taskId: string): Promise<DocumentPayload>
  getReaderAnnotations(taskId: string): Promise<ReaderAnnotation[]>
  replaceReaderAnnotations(request: ReplaceReaderAnnotationsRequest): Promise<ReaderAnnotation[]>
  openOutputDirectory(taskId: string): Promise<void>
  saveAs(request: SaveAsRequest): Promise<string | null>
  performWindowAction(action: WindowAction): Promise<WindowState>
  getWindowState(): Promise<WindowState>
  onTasksChanged(listener: (tasks: MinerUTask[]) => void): () => void
  onOpenTask(listener: (taskId: string) => void): () => void
  onWindowStateChanged(listener: (state: WindowState) => void): () => void
}

declare global {
  interface Window {
    mineru: MinerUDesktopApi
  }
}
