import type { ArtifactKind } from '@core/types'
import type { TranslationBatchCommit } from '@core/types'
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
import type { UtilitySupervisor } from './utilitySupervisor'
import type { ArtifactReference, DocumentMetadataPatch, TaskRepositoryCompat } from './taskRepositoryCompat'

/**
 * Main-side asynchronous repository port. The concrete SQLite repository is
 * utility-owned; this class is intentionally limited to explicit Core RPC
 * operations and contains no database or filesystem implementation.
 */
export class RpcTaskRepository implements TaskRepositoryCompat {
  constructor(private readonly supervisor: UtilitySupervisor) {}

  async close(): Promise<void> {
    await this.supervisor.request('database:close', {})
  }

  async getSettings(outputRoot: string): Promise<AppSettings> {
    return this.supervisor.request('settings:get', { outputRoot })
  }

  async saveSettings(settings: AppSettings): Promise<void> {
    await this.supervisor.request('settings:save', { settings })
  }

  async listTasks(): Promise<MinerUTask[]> {
    return this.supervisor.request('tasks:list', {})
  }

  async getTask(id: string): Promise<MinerUTask | null> {
    return this.supervisor.request('tasks:get', { id })
  }

  async findByHash(hash: string): Promise<MinerUTask | null> {
    return this.supervisor.request('tasks:find-by-hash', { hash })
  }

  async listDocumentSummaries(): Promise<DocumentSummary[]> {
    return this.supervisor.request('documents:list', {})
  }

  async getDocumentSummary(id: string): Promise<DocumentSummary | null> {
    return this.supervisor.request('documents:get-summary', { id })
  }

  async getLatestArtifactReference(id: string, kind: ArtifactKind): Promise<ArtifactReference | null> {
    return this.supervisor.request('artifacts:get-latest', { documentId: id, kind })
  }

  async listDocumentAnnotations(request: { documentId: string; view: 'original' | 'translated' }): Promise<ReaderAnnotationSnapshot> {
    return this.supervisor.request('annotations:list-snapshot', request)
  }

  async mutateDocumentAnnotations(request: MutateReaderAnnotationsRequest): Promise<ReaderAnnotationSnapshot> {
    return this.supervisor.request('annotations:mutate', { request })
  }

  async insertTask(task: MinerUTask): Promise<void> {
    await this.supervisor.request('tasks:insert', { task })
  }

  async insertTasks(tasks: MinerUTask[]): Promise<void> {
    await this.supervisor.request('tasks:insert-many', { tasks })
  }

  async updateDocumentMetadata(id: string, patch: DocumentMetadataPatch): Promise<void> {
    await this.supervisor.request('documents:update-metadata', { id, patch })
  }

  async updateTask(id: string, patch: Partial<MinerUTask>): Promise<MinerUTask> {
    return this.supervisor.request('tasks:update', { id, patch })
  }

  async deleteTask(id: string): Promise<void> {
    await this.supervisor.request('tasks:delete', { id })
  }

  async upsertTranslationBlock(block: TranslationBlockRecord): Promise<void> {
    await this.supervisor.request('translation:block-upsert', { block })
  }

  async commitTranslationBatch(input: TranslationBatchCommit): Promise<void> {
    await this.supervisor.request('translation:batch-commit', input)
  }

  async listTranslationBlocks(taskId: string, jobId?: string): Promise<TranslationBlockRecord[]> {
    return this.supervisor.request('translation:blocks-list', jobId === undefined ? { taskId } : { taskId, jobId })
  }

  async updateTranslationRun(taskId: string, total: number, completed: number, failed: number): Promise<void> {
    await this.supervisor.request('translation:run-update', { taskId, total, completed, failed })
  }

  async getCache(cacheKey: string): Promise<string | null> {
    const result = await this.supervisor.request('translation:cache-get', { cacheKey })
    return result.translated
  }

  async putCache(cacheKey: string, translated: string, provider: string, model: string): Promise<void> {
    await this.supervisor.request('translation:cache-put', { cacheKey, translated, provider: provider as AppSettings['translationProvider'], model })
  }

  async listReaderAnnotations(taskId: string): Promise<ReaderAnnotation[]> {
    return this.supervisor.request('annotations:list', { taskId })
  }

  async replaceReaderAnnotations(request: ReplaceReaderAnnotationsRequest): Promise<ReaderAnnotation[]> {
    return this.supervisor.request('annotations:replace', { request })
  }

  async recordArtifactRevision(
    taskId: string,
    kind: ArtifactKind,
    path: string,
    checksum: string,
    metadata: Record<string, unknown> = {},
    jobId?: string
  ): Promise<void> {
    await this.supervisor.request('artifacts:record-revision', {
      taskId,
      kind,
      path,
      checksum,
      metadata,
      ...(jobId === undefined ? {} : { jobId })
    })
  }
}
