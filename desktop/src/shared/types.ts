export type ParserModel = 'hybrid-engine' | 'pipeline'
export type TranslationProviderId = 'qwen' | 'deepseek' | 'bing' | 'transmart'

export type TaskStatus =
  | 'uploading'
  | 'parsing'
  | 'translating'
  | 'partial'
  | 'completed'
  | 'failed'

export interface AppSettings {
  parserBaseUrl: string
  hasParserToken: boolean
  outputRoot: string
  parserModel: ParserModel
  parserEffort: 'medium' | 'high'
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
  remoteTaskId: string | null
  remoteStatusUrl: string | null
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
  protocolVersion?: string
  maxConcurrentRequests?: number
}

export interface BlockBox {
  pageIndex: number
  bbox: [number, number, number, number]
  pageSize: [number, number]
  blockPosition: string
}

export interface BlockMapping {
  id: string
  order: number
  type: string
  boxes: BlockBox[]
}

export interface DocumentPayload {
  task: MinerUTask
  markdown: string
  translatedMarkdown: string
  layoutJson: string
  mappings: BlockMapping[]
  pdfUrl: string
  assetBaseUrl: string
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

export interface MinerUDesktopApi {
  getSettings(): Promise<AppSettings>
  saveSettings(update: SettingsUpdate): Promise<AppSettings>
  testParserConnection(settings?: Pick<SettingsUpdate, 'parserBaseUrl' | 'parserToken'>): Promise<HealthResult>
  testTranslationProvider(provider: TranslationProviderId): Promise<HealthResult>
  chooseOutputDirectory(): Promise<string | null>
  choosePdfs(): Promise<SelectedPdf[]>
  inspectDroppedPdfs(files: File[]): Promise<SelectedPdf[]>
  createTasks(request: CreateTasksRequest): Promise<MinerUTask[]>
  listTasks(): Promise<MinerUTask[]>
  deleteTask(request: DeleteTaskRequest): Promise<void>
  retryTask(taskId: string): Promise<void>
  getDocument(taskId: string): Promise<DocumentPayload>
  openOutputDirectory(taskId: string): Promise<void>
  saveAs(request: SaveAsRequest): Promise<string | null>
  onTasksChanged(listener: (tasks: MinerUTask[]) => void): () => void
  onOpenTask(listener: (taskId: string) => void): () => void
}

declare global {
  interface Window {
    mineru: MinerUDesktopApi
  }
}
