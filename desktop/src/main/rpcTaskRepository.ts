import type { ArtifactKind } from '@core/types'
import type { AppSettings, CopilotixTask } from '@shared/types'
import type {
  DocumentSummary,
  MutateReaderAnnotationsRequest,
  ReaderAnnotationSnapshot
} from '@shared/ipcSchemas'
import type { CoreListCursor } from '@shared/coreRpcSchemas'
import type { UtilitySupervisor } from './utilitySupervisor'
import type { DocumentMetadataPatch, TaskRepositoryCompat } from './taskRepositoryCompat'

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

  async getMigrationMarker(id: string): Promise<boolean> {
    const result = await this.supervisor.request('settings:migration-get', { id })
    return result.applied
  }

  async markMigration(id: string): Promise<void> {
    await this.supervisor.request('settings:migration-mark', { id })
  }

  async listTasks(): Promise<CopilotixTask[]> {
    return collectPages((after) => this.supervisor.request('tasks:list', after ? { after } : {}))
  }

  async getTask(id: string): Promise<CopilotixTask | null> {
    return this.supervisor.request('tasks:get', { id })
  }

  async findByHash(hash: string): Promise<CopilotixTask | null> {
    return this.supervisor.request('tasks:find-by-hash', { hash })
  }

  async listDocumentSummaries(): Promise<DocumentSummary[]> {
    return collectPages((after) => this.supervisor.request('documents:list', after ? { after } : {}))
  }

  async getDocumentSummary(id: string): Promise<DocumentSummary | null> {
    return this.supervisor.request('documents:get-summary', { id })
  }

  async listDocumentAnnotations(request: { documentId: string; view: 'original' | 'translated' }): Promise<ReaderAnnotationSnapshot> {
    return this.supervisor.request('annotations:list-snapshot', request)
  }

  async mutateDocumentAnnotations(request: MutateReaderAnnotationsRequest): Promise<ReaderAnnotationSnapshot> {
    return this.supervisor.request('annotations:mutate', { request })
  }

  async insertTasks(tasks: CopilotixTask[]): Promise<void> {
    await this.supervisor.request('tasks:insert-many', { tasks })
  }

  async updateDocumentMetadata(id: string, patch: DocumentMetadataPatch): Promise<void> {
    await this.supervisor.request('documents:update-metadata', { id, patch })
  }

  async deleteTask(id: string): Promise<void> {
    await this.supervisor.request('tasks:delete', { id })
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

/** Follow keyset cursors until the Utility reports the last page. */
async function collectPages<T>(
  fetchPage: (after: CoreListCursor | undefined) => Promise<{ items: T[]; next: CoreListCursor | null }>
): Promise<T[]> {
  const items: T[] = []
  let after: CoreListCursor | undefined
  do {
    const page = await fetchPage(after)
    items.push(...page.items)
    after = page.next ?? undefined
  } while (after)
  return items
}
