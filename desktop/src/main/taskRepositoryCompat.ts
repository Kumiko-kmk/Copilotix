import type { ArtifactKind } from '@core/types'
import type {
  AppSettings,
  MinerUTask,
  ReaderAnnotation,
  ReplaceReaderAnnotationsRequest,
  TranslationBlockRecord
} from '@shared/types'

/**
 * Temporary application adapter contract. It keeps the pre-2B services
 * source-compatible while the v2 document/job ports are introduced.
 * Remove this interface and its adapter in phase 3.
 */
export interface TaskRepositoryCompat {
  close(): void
  getSettings(outputRoot: string): AppSettings
  saveSettings(settings: AppSettings): void
  listTasks(): MinerUTask[]
  getTask(id: string): MinerUTask | null
  findByHash(hash: string): MinerUTask | null
  insertTask(task: MinerUTask): void
  insertTasks(tasks: MinerUTask[]): void
  updateTask(id: string, patch: Partial<MinerUTask>): MinerUTask
  deleteTask(id: string): void
  upsertTranslationBlock(block: TranslationBlockRecord): void
  listTranslationBlocks(taskId: string): TranslationBlockRecord[]
  updateTranslationRun(taskId: string, total: number, completed: number, failed: number): void
  getCache(cacheKey: string): string | null
  putCache(cacheKey: string, translated: string, provider: string, model: string): void
  listReaderAnnotations(taskId: string): ReaderAnnotation[]
  replaceReaderAnnotations(request: ReplaceReaderAnnotationsRequest): ReaderAnnotation[]
  recordArtifactRevision?(taskId: string, kind: ArtifactKind, path: string, checksum: string, metadata?: Record<string, unknown>): void
}
