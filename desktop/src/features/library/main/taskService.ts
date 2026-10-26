import { EventEmitter } from 'node:events'
import type { Job, JobRepositoryPort } from '@platform/jobs/core/jobs'
import type { PathPolicyPort } from '@platform/files/contract/pathPolicyPort'
import type { TaskComputePort } from '@core/ports'
import type { CopilotixTask } from '@shared/types'
import type { ImportDocumentsRequest, CacheDocumentFigureRequest } from '@shared/ipcSchemas'
import type { ImportFileOptions } from '../contract/pdfImport'
import type { SettingsService } from '@features/settings/main'
import type { TaskLogger } from '@platform/log/main/logger'
import { PathPolicy } from '@platform/files/runtime/pathPolicy'
import { ArtifactService } from '@features/reader/main'
import { DocumentCommandService, type ImportPathsResult } from './documentCommandService'
import type { TaskRepositoryCompat } from '../contract/taskRepository'
import type { JobScheduler } from '@platform/jobs/main/jobScheduler'

const silentLogger: TaskLogger = { info: () => undefined, error: () => undefined }

export interface TaskServiceOptions {
  logger?: TaskLogger
  jobRepository?: JobRepositoryPort
  scheduler?: JobScheduler
}

/**
 * Renderer-facing document facade.
 *
 * Events: `changed()` whenever document state may have changed (listeners
 * decide how and when to re-read it), and `notification(documentId, status)`
 * for user-visible workflow outcomes.
 */
export class TaskService extends EventEmitter {
  private readonly commands: DocumentCommandService
  private readonly artifacts: ArtifactService

  constructor(
    repository: TaskRepositoryCompat,
    settingsService: SettingsService,
    compute: TaskComputePort,
    pathPolicy: PathPolicyPort = new PathPolicy(),
    options: TaskServiceOptions = {}
  ) {
    super()
    this.artifacts = new ArtifactService(repository, compute, pathPolicy)
    this.commands = new DocumentCommandService(repository, settingsService, compute, pathPolicy, options.logger ?? silentLogger, options)

    options.scheduler?.on('job-changed', () => this.emit('changed'))
    options.scheduler?.on('job-notification', (job: Job) => {
      // RAG jobs share the durable scheduler but have independent state and
      // user-facing surfaces. Only document workflow jobs notify the user.
      const status = documentNotificationStatus(job)
      if (status) this.emit('notification', job.documentId, status)
    })
  }

  async list(): Promise<CopilotixTask[]> {
    return this.commands.list()
  }

  async importPaths(paths: readonly string[], options: ImportDocumentsRequest, fileOptions?: readonly ImportFileOptions[]): Promise<ImportPathsResult> {
    const result = await this.commands.importPaths(paths, options, fileOptions)
    if (result.created.length > 0) this.emit('changed')
    return result
  }

  async retry(taskId: string): Promise<void> {
    const refreshStaleTranslation = await this.artifacts.hasStaleTranslation(taskId).catch(() => false)
    await this.commands.retry(taskId, { refreshStaleTranslation })
    this.emit('changed')
  }

  async delete(taskId: string, deleteFiles: boolean): Promise<void> {
    await this.artifacts.freezeFigureWrites(taskId)
    try { await this.commands.delete(taskId, deleteFiles) } finally { this.artifacts.resumeFigureWrites(taskId) }
    this.emit('changed')
  }

  resolvedEdits(taskId: string) {
    return this.artifacts.resolvedEdits(taskId)
  }

  async retranslateEdited(taskId: string): Promise<void> {
    await this.commands.retranslateEdited(taskId)
    this.emit('changed')
  }

  async repairTextLayer(taskId: string): Promise<{ repaired: number; unresolved: number }> {
    // Figure Markdown projections are rebuilt from the repaired text afterwards.
    await this.artifacts.freezeFigureWrites(taskId)
    let result: { repaired: number; unresolved: number }
    try { result = await this.commands.repairTextLayer(taskId) } finally { this.artifacts.resumeFigureWrites(taskId) }
    if (result.repaired > 0) {
      await this.artifacts.refreshFigureMarkdown(taskId).catch(() => undefined)
      this.emit('changed')
    }
    return result
  }

  async getDocument(taskId: string) {
    return this.artifacts.getDocument(taskId)
  }

  async resolveAsset(taskId: string, assetPath: string): Promise<string> {
    return this.artifacts.resolveAsset(taskId, assetPath)
  }

  async cacheFigure(request: CacheDocumentFigureRequest) {
    return this.artifacts.cacheFigure(request)
  }

  async createResultZip(taskId: string, destination: string): Promise<void> {
    await this.artifacts.createResultZip(taskId, destination)
  }
  async exportMarkdown(taskId: string, kind: 'original-markdown' | 'translated-markdown', destination: string): Promise<void> {
    await this.artifacts.exportMarkdown(taskId, kind, destination)
  }
}

function documentNotificationStatus(job: Job): 'completed' | 'partial' | 'failed' | null {
  if (job.kind === 'parse') return job.status === 'failed' ? 'failed' : null
  if (job.kind !== 'translate') return null
  if (job.status === 'succeeded') return 'completed'
  return job.status === 'partial' || job.status === 'failed' ? job.status : null
}
