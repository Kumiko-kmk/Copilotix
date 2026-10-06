import { EventEmitter } from 'node:events'
import type { Job, JobRepositoryPort } from '@core/jobs'
import type { PathPolicyPort, TaskComputePort } from '@core/ports'
import type { CopilotixTask } from '@shared/types'
import type { ImportDocumentsRequest } from '@shared/ipcSchemas'
import type { SettingsService } from './settingsService'
import type { TaskLogger } from './logger'
import { PathPolicy } from './pathPolicy'
import { ArtifactService } from './artifactService'
import { DocumentCommandService, type ImportPathsResult } from './documentCommandService'
import type { TaskRepositoryCompat } from './taskRepositoryCompat'
import type { JobScheduler } from './jobScheduler'

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

  async importPaths(paths: readonly string[], options: ImportDocumentsRequest): Promise<ImportPathsResult> {
    const result = await this.commands.importPaths(paths, options)
    if (result.created.length > 0) this.emit('changed')
    return result
  }

  async retry(taskId: string): Promise<void> {
    await this.commands.retry(taskId)
    this.emit('changed')
  }

  async delete(taskId: string, deleteFiles: boolean): Promise<void> {
    await this.commands.delete(taskId, deleteFiles)
    this.emit('changed')
  }

  async getDocument(taskId: string) {
    return this.artifacts.getDocument(taskId)
  }

  async resolveAsset(taskId: string, assetPath: string): Promise<string> {
    return this.artifacts.resolveAsset(taskId, assetPath)
  }

  async createResultZip(taskId: string, destination: string): Promise<void> {
    await this.artifacts.createResultZip(taskId, destination)
  }
}

function documentNotificationStatus(job: Job): 'completed' | 'partial' | 'failed' | null {
  if (job.kind === 'parse') return job.status === 'failed' ? 'failed' : null
  if (job.kind !== 'translate') return null
  if (job.status === 'succeeded') return 'completed'
  return job.status === 'partial' || job.status === 'failed' ? job.status : null
}
