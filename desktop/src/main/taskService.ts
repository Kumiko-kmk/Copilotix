import { EventEmitter } from 'node:events'
import type { JobRepositoryPort } from '@core/jobs'
import type { PathPolicyPort, TaskComputePort } from '@core/ports'
import type { CreateTasksRequest, MinerUTask, SelectedPdf } from '@shared/types'
import type { CredentialVault } from './credentialVault'
import type { MinerUClient } from './parserClient'
import type { SettingsService } from './settingsService'
import type { TaskLogger } from './logger'
import { PathPolicy } from './pathPolicy'
import { ArtifactService } from './artifactService'
import { DocumentCommandService } from './documentCommandService'
import type { TaskRepositoryCompat } from './taskRepositoryCompat'
import type { JobScheduler } from './jobScheduler'

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

const silentLogger: TaskLogger = { info: () => undefined, error: () => undefined }

export interface TaskServiceOptions {
  jobRepository?: JobRepositoryPort
  scheduler?: JobScheduler
}

/** Thin compatibility facade preserving the renderer-facing TaskService API. */
export class TaskService extends EventEmitter {
  private readonly commands: DocumentCommandService
  private readonly artifacts: ArtifactService

  constructor(
    repository: TaskRepositoryCompat,
    settingsService: SettingsService,
    _vault: CredentialVault,
    _parserClient: MinerUClient,
    _fetcher: Fetcher,
    loggerOrCompute: TaskLogger | TaskComputePort = silentLogger,
    computeOrPathPolicy?: TaskComputePort | PathPolicyPort,
    pathPolicy: PathPolicyPort = new PathPolicy(),
    options: TaskServiceOptions = {}
  ) {
    super()
    const logger = isTaskLogger(loggerOrCompute) ? loggerOrCompute : silentLogger
    const compute = isTaskComputePort(loggerOrCompute)
      ? loggerOrCompute
      : isTaskComputePort(computeOrPathPolicy)
        ? computeOrPathPolicy
        : unavailableCompute()
    const resolvedPathPolicy = isPathPolicyPort(computeOrPathPolicy) ? computeOrPathPolicy : pathPolicy
    this.artifacts = new ArtifactService(repository, compute, resolvedPathPolicy)
    this.commands = new DocumentCommandService(repository, settingsService, compute, resolvedPathPolicy, logger, options)

    options.scheduler?.on('job-changed', () => { void this.emitTasks().catch(() => undefined) })
    options.scheduler?.on('job-notification', (taskId: string, status: string, kind: string) => {
      if ((kind === 'translate' || status === 'failed') && (status === 'succeeded' || status === 'partial' || status === 'failed')) {
        this.emit('notification', taskId, status === 'succeeded' ? 'completed' : status)
      }
    })
  }

  async list(): Promise<MinerUTask[]> {
    return this.commands.list()
  }

  async inspectPdfs(paths: string[]): Promise<SelectedPdf[]> {
    return this.commands.inspectPdfs(paths)
  }

  async create(request: CreateTasksRequest): Promise<MinerUTask[]> {
    const created = await this.commands.create(request)
    await this.emitTasks()
    return created
  }

  async importPaths(paths: readonly string[], options: Omit<CreateTasksRequest, 'files'>): Promise<MinerUTask[]> {
    const created = await this.commands.importPaths(paths, options)
    await this.emitTasks()
    return created
  }

  async retry(taskId: string): Promise<void> {
    await this.commands.retry(taskId)
    await this.emitTasks()
  }

  async delete(taskId: string, deleteFiles: boolean): Promise<void> {
    await this.commands.delete(taskId, deleteFiles)
    await this.emitTasks()
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

  private async emitTasks(): Promise<void> {
    this.emit('changed', await this.list())
  }
}

export function splitIntoMinerUBatches<T>(values: T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error('Batch size must be positive')
  const groups: T[][] = []
  for (let index = 0; index < values.length; index += size) groups.push(values.slice(index, index + size))
  return groups
}

function isTaskLogger(value: unknown): value is TaskLogger {
  return Boolean(value && typeof value === 'object' && typeof (value as { info?: unknown }).info === 'function' && typeof (value as { error?: unknown }).error === 'function')
}

function isTaskComputePort(value: unknown): value is TaskComputePort {
  return Boolean(value && typeof value === 'object' && typeof (value as { hashFile?: unknown }).hashFile === 'function')
}

function isPathPolicyPort(value: unknown): value is PathPolicyPort {
  return Boolean(value && typeof value === 'object' && typeof (value as { resolveChild?: unknown }).resolveChild === 'function')
}

function unavailableCompute(): TaskComputePort {
  const unavailable = async (): Promise<never> => { throw new Error('核心计算服务尚未初始化') }
  return {
    hashFile: unavailable,
    importPdf: unavailable,
    normalizeParserOutput: unavailable,
    rebuildMappings: unavailable,
    openTranslationPlan: unavailable,
    listTranslationWork: unavailable,
    tryTranslationCache: unavailable,
    applyTranslation: unavailable,
    failTranslation: unavailable,
    finalizeTranslation: unavailable
  }
}
