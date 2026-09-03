import { copyFile, mkdir, rm, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { v4 as uuidv4 } from 'uuid'
import type { Job, JobRepositoryPort } from '@core/jobs'
import type { PathPolicyPort, TaskComputePort } from '@core/ports'
import { MAX_PDF_BYTES } from '@shared/constants'
import type { CreateTasksRequest, MinerUTask, SelectedPdf } from '@shared/types'
import type { SettingsService } from './settingsService'
import type { TaskLogger } from './logger'
import type { TaskRepositoryCompat } from './taskRepositoryCompat'
import type { JobScheduler } from './jobScheduler'

export interface DocumentCommandServiceOptions {
  jobRepository?: JobRepositoryPort
  scheduler?: JobScheduler
}

/** User-facing document commands. Commands enqueue/cancel durable jobs only. */
export class DocumentCommandService {
  private readonly jobRepository?: JobRepositoryPort
  private readonly scheduler?: JobScheduler

  constructor(
    private readonly repository: TaskRepositoryCompat,
    private readonly settingsService: SettingsService,
    private readonly compute: TaskComputePort,
    private readonly pathPolicy: PathPolicyPort,
    private readonly logger: TaskLogger,
    options: DocumentCommandServiceOptions = {}
  ) {
    this.jobRepository = options.jobRepository
    this.scheduler = options.scheduler
  }

  async list(): Promise<MinerUTask[]> {
    return this.repository.listTasks()
  }

  async inspectPdfs(paths: string[]): Promise<SelectedPdf[]> {
    return Promise.all(paths.map(async (path) => {
      const info = await stat(path)
      const hash = await this.compute.hashFile(path)
      return {
        path,
        name: path.split(/[\\/]/u).at(-1) ?? path,
        size: info.size,
        duplicateTask: (await this.repository.findByHash(hash)) ?? undefined
      }
    }))
  }

  async create(request: CreateTasksRequest): Promise<MinerUTask[]> {
    const settings = await this.settingsService.get()
    if (!settings.hasParserToken) throw new Error('请先在系统设置中配置 MinerU API Token')
    for (const file of request.files) {
      if (extname(file.path).toLowerCase() !== '.pdf') continue
      const info = await stat(file.path)
      if (info.size > MAX_PDF_BYTES) throw new Error(`${file.name} 超过 MinerU 官方 API 的 200MB 限制`)
    }

    await mkdir(settings.outputRoot, { recursive: true })
    const documentsRoot = join(settings.outputRoot, 'documents-v2')
    await mkdir(documentsRoot, { recursive: true })
    const created: MinerUTask[] = []
    for (const file of request.files) {
      if (extname(file.path).toLowerCase() !== '.pdf') continue
      const sourceHash = await this.compute.hashFile(file.path)
      if (!request.createDuplicates && await this.repository.findByHash(sourceHash)) continue
      const id = uuidv4()
      const outputDir = this.pathPolicy.resolveChild(documentsRoot, join(documentsRoot, id))
      await mkdir(outputDir, { recursive: true })
      const localPdf = join(outputDir, 'original.pdf')
      await copyFile(file.path, localPdf)
      const now = new Date().toISOString()
      created.push({
        id,
        originalName: file.name,
        title: null,
        name: file.name,
        sourcePath: localPdf,
        sourceHash,
        outputDir,
        status: 'uploading',
        progress: 0,
        parserModel: request.parserModel,
        translationProvider: request.translationProvider,
        remoteBatchId: null,
        remoteDataId: null,
        remoteResultUrl: null,
        error: null,
        createdAt: now,
        updatedAt: now
      })
    }

    await this.repository.insertTasks(created)
    await this.ensureParseJobs(created)
    this.scheduler?.wake()
    this.logger.info('documents.created', { count: created.length })
    return created
  }

  /** Production import path: utility reads each source once, hashes it, and publishes original.pdf atomically. */
  async importPaths(paths: readonly string[], options: Omit<CreateTasksRequest, 'files'>): Promise<MinerUTask[]> {
    if (!this.compute.importPdf) throw new Error('核心导入服务尚未初始化')
    const settings = await this.settingsService.get()
    if (!settings.hasParserToken) throw new Error('请先在系统设置中配置 MinerU API Token')
    await mkdir(settings.outputRoot, { recursive: true })
    const documentsRoot = join(settings.outputRoot, 'documents-v2')
    await mkdir(documentsRoot, { recursive: true })

    const created: MinerUTask[] = []
    const seenHashes = new Set<string>()
    const unpersistedOutputDirs = new Set<string>()
    try {
      for (const sourcePath of paths) {
        if (extname(sourcePath).toLowerCase() !== '.pdf') continue
        const id = uuidv4()
        const outputDir = this.pathPolicy.resolveChild(documentsRoot, id)
        await mkdir(outputDir, { recursive: true })
        unpersistedOutputDirs.add(outputDir)
        const imported = await this.compute.importPdf(sourcePath, id)
        const duplicate = !options.createDuplicates && (seenHashes.has(imported.sha256) || await this.repository.findByHash(imported.sha256))
        if (duplicate) {
          await rm(outputDir, { recursive: true, force: true })
          unpersistedOutputDirs.delete(outputDir)
          continue
        }
        seenHashes.add(imported.sha256)
        const now = new Date().toISOString()
        const name = basename(sourcePath)
        created.push({
          id,
          originalName: name,
          title: null,
          name,
          sourcePath: join(outputDir, 'original.pdf'),
          sourceHash: imported.sha256,
          outputDir,
          status: 'uploading',
          progress: 0,
          parserModel: options.parserModel,
          translationProvider: options.translationProvider,
          remoteBatchId: null,
          remoteDataId: null,
          remoteResultUrl: null,
          error: null,
          createdAt: now,
          updatedAt: now
        })
      }

      if (created.length > 0) {
        await this.repository.insertTasks(created)
        for (const task of created) unpersistedOutputDirs.delete(task.outputDir)
        await this.ensureParseJobs(created)
        this.scheduler?.wake()
        this.logger.info('documents.created', { count: created.length })
      }
      return created
    } catch (error) {
      await Promise.all([...unpersistedOutputDirs].map((outputDir) => rm(outputDir, { recursive: true, force: true }).catch(() => undefined)))
      throw error
    }
  }

  async retry(taskId: string): Promise<void> {
    const task = await this.repository.getTask(taskId)
    if (!task) throw new Error('任务不存在')
    if (this.jobRepository) {
      const jobs = await this.jobRepository.list({ documentId: taskId })
      const candidates = jobs
        .filter((job) => job.status === 'failed' || job.status === 'cancelled')
        .sort(compareJobs)
      const job = candidates.at(-1)
      if (!job) throw new Error('任务当前不可重试')
      await this.jobRepository.manualRetry({ jobId: job.id, now: new Date().toISOString() })
      this.scheduler?.wake()
      return
    }

    // Kept only for direct legacy fixtures; production always supplies the job port.
    const updated = await this.repository.updateTask(taskId, {
      status: task.remoteBatchId ? 'parsing' : 'uploading',
      error: null
    })
    this.logger.info('legacy.retry', { taskId: updated.id })
  }

  async delete(taskId: string, deleteFiles: boolean): Promise<void> {
    const task = await this.repository.getTask(taskId)
    if (!task) return
    await this.scheduler?.cancelDocument(taskId)
    if (deleteFiles) {
      const settings = await this.settingsService.get()
      const root = join(settings.outputRoot, 'documents-v2')
      const target = this.pathPolicy.resolveChild(root, task.outputDir)
      await rm(target, { recursive: true, force: true })
    }
    await this.repository.deleteTask(taskId)
    this.logger.info('documents.deleted', { taskId })
  }

  private async ensureParseJobs(tasks: readonly MinerUTask[]): Promise<void> {
    if (!this.jobRepository) return
    for (const task of tasks) {
      const existing = await this.jobRepository.list({ documentId: task.id, kind: 'parse' })
      if (existing.length > 0) continue
      await this.jobRepository.enqueue({
        documentId: task.id,
        kind: 'parse',
        checkpoint: { phase: 'queued' },
        now: task.createdAt
      })
    }
  }
}

function compareJobs(left: Job, right: Job): number {
  return left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id)
}
