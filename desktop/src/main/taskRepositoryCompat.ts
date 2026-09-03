import type { ArtifactKind } from '@core/types'
import type {
  AppSettings,
  MinerUTask,
  ReaderAnnotation,
  ReplaceReaderAnnotationsRequest,
  TranslationBlockRecord
} from '@shared/types'
import type {
  DocumentSummary,
  MutateReaderAnnotationsRequest,
  ReaderAnnotationSnapshot
} from '@shared/ipcSchemas'

/**
 * Main-process persistence port. Production implementations are asynchronous
 * RPC proxies; the union keeps the direct utility-owned fixture adapters
 * source-compatible for focused persistence tests only.
 */
export interface TaskRepositoryCompat {
  close(): void | Promise<void>
  getSettings(outputRoot: string): AppSettings | Promise<AppSettings>
  saveSettings(settings: AppSettings): void | Promise<void>
  listTasks(): MinerUTask[] | Promise<MinerUTask[]>
  getTask(id: string): MinerUTask | null | Promise<MinerUTask | null>
  findByHash(hash: string): MinerUTask | null | Promise<MinerUTask | null>
  /** New document API projections; optional for the legacy database adapter. */
  listDocumentSummaries?(): DocumentSummary[] | Promise<DocumentSummary[]>
  getDocumentSummary?(id: string): DocumentSummary | null | Promise<DocumentSummary | null>
  getLatestArtifactReference?(id: string, kind: ArtifactKind): ArtifactReference | null | Promise<ArtifactReference | null>
  listDocumentAnnotations?(request: { documentId: string; view: 'original' | 'translated' }): ReaderAnnotationSnapshot | Promise<ReaderAnnotationSnapshot>
  mutateDocumentAnnotations?(request: MutateReaderAnnotationsRequest): ReaderAnnotationSnapshot | Promise<ReaderAnnotationSnapshot>
  insertTask(task: MinerUTask): void | Promise<void>
  insertTasks(tasks: MinerUTask[]): void | Promise<void>
  updateTask(id: string, patch: Partial<MinerUTask>): MinerUTask | Promise<MinerUTask>
  deleteTask(id: string): void | Promise<void>
  upsertTranslationBlock(block: TranslationBlockRecord): void | Promise<void>
  listTranslationBlocks(taskId: string): TranslationBlockRecord[] | Promise<TranslationBlockRecord[]>
  updateTranslationRun(taskId: string, total: number, completed: number, failed: number): void | Promise<void>
  getCache(cacheKey: string): string | null | Promise<string | null>
  putCache(cacheKey: string, translated: string, provider: string, model: string): void | Promise<void>
  listReaderAnnotations(taskId: string): ReaderAnnotation[] | Promise<ReaderAnnotation[]>
  replaceReaderAnnotations(request: ReplaceReaderAnnotationsRequest): ReaderAnnotation[] | Promise<ReaderAnnotation[]>
  recordArtifactRevision?(taskId: string, kind: ArtifactKind, path: string, checksum: string, metadata?: Record<string, unknown>): void | Promise<void>
}

export interface ArtifactReference {
  id: string
  documentId: string
  kind: ArtifactKind
  revision: number
  relativePath: string
  contentHash: string
  metadata: Record<string, unknown>
}
