import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { Job, JobRepositoryPort } from '@core/jobs'
import type { PathPolicyPort, TaskComputePort } from '@core/ports'
import type { CopilotixTask } from '@shared/types'
import type { ImportDocumentsRequest } from '@shared/ipcSchemas'
import type { SettingsService } from './settingsService'
import type { TaskLogger } from './logger'
import type { TaskRepositoryCompat } from './taskRepositoryCompat'
import type { JobScheduler } from './jobScheduler'

export interface ImportFailure {
  name: string
  message: string
}

export interface ImportPathsResult {
  created: CopilotixTask[]
  failed: ImportFailure[]
}

/** Matches the Core RPC `tasks:insert-many` limit. */
const INSERT_BATCH_SIZE = 100

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

  async list(): Promise<CopilotixTask[]> {
    return this.repository.listTasks()
  }

  /**
   * Production import path: utility reads each source once, hashes it, and
   * publishes original.pdf atomically. A file that cannot be imported is
   * reported in `failed` while the rest of the selection continues.
   */
  async importPaths(paths: readonly string[], options: ImportDocumentsRequest): Promise<ImportPathsResult> {
    if (!this.compute.importPdf) throw new Error('核心导入服务尚未初始化')
    const settings = await this.settingsService.get()
    assertParserCredentialUsable(settings)
    await mkdir(settings.outputRoot, { recursive: true })
    const documentsRoot = join(settings.outputRoot, 'documents-v2')
    await mkdir(documentsRoot, { recursive: true })

    const created: CopilotixTask[] = []
    const failed: ImportFailure[] = []
    const seenHashes = new Set<string>()
    const unpersistedOutputDirs = new Set<string>()
    try {
      for (const sourcePath of paths) {
        if (extname(sourcePath).toLowerCase() !== '.pdf') continue
        const id = randomUUID()
        const outputDir = this.pathPolicy.resolveChild(documentsRoot, id)
        let imported: { sha256: string }
        try {
          await mkdir(outputDir, { recursive: true })
          unpersistedOutputDirs.add(outputDir)
          imported = await this.compute.importPdf(sourcePath, id)
        } catch (error) {
          await rm(outputDir, { recursive: true, force: true }).catch(() => undefined)
          unpersistedOutputDirs.delete(outputDir)
          failed.push({ name: basename(sourcePath), message: importFailureMessage(error) })
          continue
        }
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
          title: options.useOriginalFilename ? originalFilenameTitle(name) : null,
          name,
          sourcePath: join(outputDir, 'original.pdf'),
          sourceHash: imported.sha256,
          outputDir,
          status: 'uploading',
          progress: 0,
          translationProvider: settings.enabledTranslationProviders[0]!,
          remoteBatchId: null,
          remoteDataId: null,
          remoteResultUrl: null,
          error: null,
          createdAt: now,
          updatedAt: now
        })
      }

      if (created.length > 0) {
        // The Utility inserts each document together with its queued parse
        // job. Batches keep large selections within the RPC limits.
        for (let start = 0; start < created.length; start += INSERT_BATCH_SIZE) {
          const batch = created.slice(start, start + INSERT_BATCH_SIZE)
          await this.repository.insertTasks(batch)
          for (const task of batch) unpersistedOutputDirs.delete(task.outputDir)
        }
        this.scheduler?.wake()
        this.logger.info('documents.created', { count: created.length })
      }
      if (failed.length > 0) this.logger.info('documents.import-failed', { count: failed.length })
      return { created, failed }
    } catch (error) {
      await Promise.all([...unpersistedOutputDirs].map((outputDir) => rm(outputDir, { recursive: true, force: true }).catch(() => undefined)))
      throw error
    }
  }

  async retry(taskId: string): Promise<void> {
    if (!this.jobRepository) throw new Error('作业队列尚未初始化')
    if (!await this.repository.getTask(taskId)) throw new Error('任务不存在')
    const jobs = await this.jobRepository.list({ documentId: taskId })
    const activeTranslation = jobs.find((job) => job.kind === 'translate' && job.status === 'running')
    if (activeTranslation && this.scheduler) {
      await this.scheduler.cancel(activeTranslation.id)
      const stopped = await this.jobRepository.get(activeTranslation.id)
      if (stopped?.status !== 'cancelled') throw new Error('翻译状态已变化，请刷新后重试')
      await this.jobRepository.manualRetry({ jobId: stopped.id, now: new Date().toISOString() })
      this.scheduler.wake()
      return
    }
    const job = jobs
      .filter((candidate) => (candidate.kind === 'parse' || candidate.kind === 'translate') &&
        (candidate.status === 'partial' || candidate.status === 'failed' || candidate.status === 'cancelled'))
      .sort(compareJobs)
      .at(-1)
    if (!job) throw new Error('任务当前不可重试')
    await this.jobRepository.manualRetry({ jobId: job.id, now: new Date().toISOString() })
    this.scheduler?.wake()
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
}

function importFailureMessage(error: unknown): string {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
  if (code === 'CORE_LIMIT_EXCEEDED') return '超过 200MB 或 600 页的解析限制'
  if (code === 'CORE_NOT_FOUND') return '文件不存在或无法读取'
  if (code === 'CORE_PROTOCOL_ERROR') return '不是可导入的 PDF 文件'
  return '导入失败，请稍后重试'
}

function originalFilenameTitle(name: string): string | null {
  const extension = extname(name)
  const title = basename(name, extension).trim()
  return title || null
}

function assertParserCredentialUsable(settings: Awaited<ReturnType<SettingsService['get']>>): void {
  if (settings.credentials.parser.state === 'missing') throw new Error('请先在系统设置中配置 Parser API Token')
  if (settings.credentials.parser.state === 'invalid') throw new Error('Parser API Token 已失效，请在系统设置中重新验证')
}

function compareJobs(left: Job, right: Job): number {
  return left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id)
}
