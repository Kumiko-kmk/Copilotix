import { EventEmitter } from 'node:events'
import type { Job, JobRepositoryPort } from '@platform/jobs/core/jobs'
import type { PathPolicyPort } from '@platform/files/contract/pathPolicyPort'
import type { TaskComputePort } from '../contract/taskCompute'
import type { CopilotixTask } from '../contract/documentTypes'
import type { ImportDocumentsRequest } from '../contract/documentSchemas'
import type { CacheDocumentFigureRequest } from '@features/reader/contract/readerSchemas'
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
    private readonly repository: TaskRepositoryCompat,
    settingsService: SettingsService,
    compute: TaskComputePort,
    pathPolicy: PathPolicyPort = new PathPolicy(),
    options: TaskServiceOptions = {}
  ) {
    super()
    this.artifacts = new ArtifactService(repository, compute, pathPolicy)
    this.commands = new DocumentCommandService(repository, settingsService, compute, pathPolicy, options.logger ?? silentLogger, options)

    options.scheduler?.on('job-changed', (job: Job) => {
      if (job.kind !== 'parse' && job.kind !== 'translate') return
      const published = ['succeeded', 'partial'].includes(job.status)
      this.emit('changed', { documentId: job.documentId, kind: published ? (job.kind === 'parse' ? 'body' : 'translation') : 'progress', version: job.id + ':' + job.attempt + ':' + job.progress })
    })
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
    for (const task of result.created) this.emit('changed', { documentId: task.id, kind: 'metadata' })
    return result
  }

  async retry(taskId: string): Promise<void> {
    const refreshStaleTranslation = await this.artifacts.hasStaleTranslation(taskId).catch(() => false)
    await this.commands.retry(taskId, { refreshStaleTranslation })
    this.emit('changed', { documentId: taskId, kind: 'progress' })
  }

  async delete(taskId: string, deleteFiles: boolean): Promise<void> {
    await this.artifacts.freezeFigureWrites(taskId)
    try { await this.commands.delete(taskId, deleteFiles) } finally { this.artifacts.resumeFigureWrites(taskId) }
    this.emit('changed', { documentId: taskId, kind: 'delete' })
  }

  /** The user's own title; parsing keeps it (it only fills a title that is missing or still provisional). */
  async rename(taskId: string, title: string): Promise<void> {
    const displayTitle = title.trim().replace(/.pdf$/iu, '').trim()
    if (!displayTitle) throw new Error('標題不能為空')
    await this.repository.updateDocumentMetadata(taskId, { displayTitle })
    this.emit('changed', { documentId: taskId, kind: 'metadata' })
  }

  resolvedEdits(taskId: string) {
    return this.artifacts.resolvedEdits(taskId)
  }

  async retranslateEdited(taskId: string): Promise<void> {
    await this.commands.retranslateEdited(taskId)
    this.emit('changed', { documentId: taskId, kind: 'progress' })
  }

  async repairTextLayer(taskId: string): Promise<{ repaired: number; unresolved: number }> {
    // Figure Markdown projections are rebuilt from the repaired text afterwards.
    await this.artifacts.freezeFigureWrites(taskId)
    let result: { repaired: number; unresolved: number }
    try { result = await this.commands.repairTextLayer(taskId) } finally { this.artifacts.resumeFigureWrites(taskId) }
    if (result.repaired > 0) {
      await this.artifacts.refreshFigureMarkdown(taskId).catch(() => undefined)
      this.emit('changed', { documentId: taskId, kind: 'body' })
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
