import { createWriteStream } from 'node:fs'
import {
  access,
  copyFile,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { EventEmitter } from 'node:events'
import archiver from 'archiver'
import extract from 'extract-zip'
import PQueue from 'p-queue'
import { v4 as uuidv4 } from 'uuid'
import type {
  BlockMapping,
  CreateTasksRequest,
  DocumentPayload,
  MinerUTask,
  SelectedPdf,
  TranslatedMarkdownBlock,
} from '@shared/types'
import type { ArtifactKind } from '@core/types'
import { MAX_PDF_BYTES, MINERU_BATCH_SIZE } from '@shared/constants'
import type { TaskRepositoryCompat } from './taskRepositoryCompat'
import type { PathPolicyPort } from '@core/ports'
import { PathPolicy } from './pathPolicy'
import type { CredentialVault } from './credentialVault'
import type { SettingsService } from './settingsService'
import { MinerUApiError, type BatchResult, type MinerUClient } from './parserClient'
import type { TaskComputePort } from '@core/ports'
import { MARKDOWN_MAPPING_ALGORITHM_VERSION } from '@shared/markdownBlocks'
import { createTranslationProviders } from './translation/providers'
import { TRANSLATION_PIPELINE_VERSION, translateMarkdown, type TranslationResult } from './translation/markdownPipeline'
import { TABLE_TRANSLATION_PROTOCOL } from './translation/tableTranslation'
import type { TaskLogger } from './logger'
import { extractPaperTitle, sanitizeTitleStem } from './titleNaming'

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
const BLOCK_MAPPING_VERSION = 2

const silentLogger: TaskLogger = {
  info: () => undefined,
  error: () => undefined
}

export class TaskService extends EventEmitter {
  private readonly queue = new PQueue({ concurrency: 2 })
  private readonly resultQueue = new PQueue({ concurrency: 3 })
  private readonly remoteSnapshots = new Map<string, string>()
  private readonly taskCache = new Map<string, MinerUTask>()
  private readonly logger: TaskLogger
  private readonly compute?: TaskComputePort
  private readonly pathPolicy: PathPolicyPort

  constructor(
    private readonly repository: TaskRepositoryCompat,
    private readonly settingsService: SettingsService,
    private readonly vault: CredentialVault,
    private readonly parserClient: MinerUClient,
    private readonly fetcher: Fetcher,
    loggerOrCompute: TaskLogger | TaskComputePort = silentLogger,
    computeOrPathPolicy?: TaskComputePort | PathPolicyPort,
    pathPolicy: PathPolicyPort = new PathPolicy()
  ) {
    super()
    // Keep the focused legacy tests source-compatible while production passes
    // logger, compute, and (optionally) path policy explicitly.  Both ports are
    // intentionally structural so this adapter does not pull persistence into
    // the main process.
    if (isTaskComputePort(loggerOrCompute)) {
      this.logger = silentLogger
      this.compute = loggerOrCompute
      this.pathPolicy = isPathPolicyPort(computeOrPathPolicy) ? computeOrPathPolicy : pathPolicy
      return
    }
    this.logger = loggerOrCompute
    this.compute = isTaskComputePort(computeOrPathPolicy) ? computeOrPathPolicy : undefined
    this.pathPolicy = isPathPolicyPort(computeOrPathPolicy) ? computeOrPathPolicy : pathPolicy
  }

  async list(): Promise<MinerUTask[]> {
    const tasks = await this.repository.listTasks()
    this.taskCache.clear()
    for (const task of tasks) this.taskCache.set(task.id, task)
    return tasks
  }

  async inspectPdfs(paths: string[]): Promise<SelectedPdf[]> {
    return Promise.all(
      paths.map(async (path) => {
        const info = await stat(path)
        const hash = await this.computeRequired().hashFile(path)
        return {
          path,
          name: basename(path),
          size: info.size,
          duplicateTask: (await this.repository.findByHash(hash)) ?? undefined
        }
      })
    )
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
      const sourceHash = await this.computeRequired().hashFile(file.path)
      if (!request.createDuplicates && await this.repository.findByHash(sourceHash)) continue
      const id = uuidv4()
      const outputDir = this.pathPolicy.resolveChild(documentsRoot, join(documentsRoot, id))
      await mkdir(outputDir, { recursive: true })
      const localPdf = join(outputDir, 'original.pdf')
      await copyFile(file.path, localPdf)
      const now = new Date().toISOString()
      const task: MinerUTask = {
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
      }
      created.push(task)
    }
    await this.repository.insertTasks(created)
    for (const task of created) this.taskCache.set(task.id, task)
    for (const batch of splitIntoMinerUBatches(created, MINERU_BATCH_SIZE)) this.enqueueBatch(batch.map((task) => task.id))
    await this.emitTasks()
    return created
  }

  async retry(taskId: string): Promise<void> {
    const task = await this.repository.getTask(taskId)
    if (!task) throw new Error('任务不存在')
    const updated = await this.repository.updateTask(taskId, { status: task.remoteBatchId ? 'parsing' : 'uploading', error: null })
    this.taskCache.set(taskId, updated)
    await this.emitTasks()
    if (task.remoteBatchId && task.remoteDataId) this.enqueueResume(taskId)
    else this.enqueueBatch([taskId])
  }

  async delete(taskId: string, deleteFiles: boolean): Promise<void> {
    const task = await this.repository.getTask(taskId)
    if (!task) return
    if (deleteFiles) {
      const settings = await this.settingsService.get()
      const root = join(settings.outputRoot, 'documents-v2')
      const target = this.pathPolicy.resolveChild(root, task.outputDir)
      await rm(target, { recursive: true, force: true })
    }
    await this.repository.deleteTask(taskId)
    this.taskCache.delete(taskId)
    await this.emitTasks()
  }

  async getDocument(taskId: string): Promise<DocumentPayload> {
    const task = await this.repository.getTask(taskId)
    if (!task) throw new Error('任务不存在')
    this.taskCache.set(task.id, task)
    const markdown = await readOptional(join(task.outputDir, 'full.md'))
    const translatedMarkdown = await readOptional(join(task.outputDir, 'full.zh-CN.md'))
    const translatedBlocks = await this.loadTranslatedBlocks(task)
    const layoutJson = await readOptional(join(task.outputDir, 'layout.json'), '{}')
    const mappings = await this.loadMappings(task)
    return {
      task,
      markdown,
      translatedMarkdown,
      translatedBlocks,
      layoutJson,
      mappings,
      pdfUrl: `mineru-asset://${task.id}/original.pdf`,
      assetBaseUrl: `mineru-asset://${task.id}/`
    }
  }

  async resolveAsset(taskId: string, assetPath: string): Promise<string> {
    const task = await this.repository.getTask(taskId)
    if (!task) throw new Error('任务不存在')
    this.taskCache.set(task.id, task)
    return this.pathPolicy.resolveChild(task.outputDir, decodeURIComponent(assetPath.replace(/^\/+/, '')))
  }

  async createResultZip(taskId: string, destination: string): Promise<void> {
    const task = await this.repository.getTask(taskId)
    if (!task) throw new Error('任务不存在')
    this.taskCache.set(task.id, task)
    await new Promise<void>((resolvePromise, reject) => {
      const output = createWriteStream(destination)
      const archive = archiver('zip', { zlib: { level: 9 } })
      output.on('close', () => resolvePromise())
      output.on('error', reject)
      archive.on('error', reject)
      archive.pipe(output)
      archive.directory(task.outputDir, false)
      void archive.finalize()
    })
  }

  private enqueueBatch(taskIds: string[]): void {
    void this.queue.add(() => this.processNewBatch(taskIds))
  }

  private enqueueResume(taskId: string): void {
    void this.queue.add(() => this.resumeTask(taskId))
  }

  private async processNewBatch(taskIds: string[]): Promise<void> {
    const tasks = (await Promise.all(taskIds.map((taskId) => this.repository.getTask(taskId))))
      .filter((task): task is MinerUTask => Boolean(task))
    if (tasks.length === 0) return
    this.logger.info('batch.start', { taskIds })
    try {
      const settings = await this.settingsService.get()
      const token = await this.vault.get('parser-token')
      if (!token) throw new Error('未配置 MinerU API Token')
      const submission = await this.parserClient.createUploadBatch(tasks, settings, token)
      this.logger.info('batch.created', { batchId: submission.batchId, taskIds })
      for (const upload of submission.uploads) {
        await this.repository.updateTask(upload.taskId, {
          status: 'uploading',
          progress: 1,
          remoteBatchId: submission.batchId,
          remoteDataId: upload.dataId,
          remoteResultUrl: null,
          error: null
        })
      }
      await this.emitTasks()

      const uploadedTaskIds = new Set<string>()
      const uploadQueue = new PQueue({ concurrency: 3 })
      await Promise.all(
        submission.uploads.map((upload) => uploadQueue.add(async () => {
          const task = await this.repository.getTask(upload.taskId)
          if (!task) return
          let lastProgress = -1
          try {
            this.logger.info('upload.start', { taskId: task.id, batchId: submission.batchId, bytes: (await stat(task.sourcePath)).size })
            await this.parserClient.uploadFile(task.sourcePath, upload.uploadUrl, (sent, total) => {
              const progress = Math.min(8, Math.max(1, Math.round((sent / total) * 8)))
              if (progress === lastProgress) return
              lastProgress = progress
              void Promise.resolve(this.repository.updateTask(task.id, { status: 'uploading', progress }))
                .then((updated) => { this.taskCache.set(task.id, updated) })
                .catch(() => undefined)
              void this.emitTasks().catch(() => undefined)
            })
            uploadedTaskIds.add(task.id)
            await this.repository.updateTask(task.id, { status: 'parsing', progress: 10 })
            this.logger.info('upload.completed', { taskId: task.id, batchId: submission.batchId })
          } catch (error) {
            this.logger.error('upload.failed', error, { taskId: task.id, batchId: submission.batchId })
            try { await this.markTaskFailed(task.id, error) } catch { /* preserve the original upload failure */ }
          }
        }))
      )
      await this.emitTasks()
      if (uploadedTaskIds.size === 0) return

      const finalResult = await this.parserClient.waitForBatch(
        submission.batchId,
        token,
        uploadedTaskIds,
        (result) => { void this.applyBatchProgress(result, uploadedTaskIds) }
      )
      await this.finishBatch(finalResult, uploadedTaskIds, settings)
    } catch (error) {
      this.logger.error('batch.failed', error, { taskIds })
      for (const task of tasks) {
        const current = await this.repository.getTask(task.id)
        if (current && !['completed', 'partial', 'failed'].includes(current.status)) {
          try { await this.markTaskFailed(task.id, error) } catch { /* preserve the original batch failure */ }
        }
      }
      await this.emitTasks()
    }
  }

  private async resumeTask(taskId: string): Promise<void> {
    const task = await this.repository.getTask(taskId)
    if (!task?.remoteBatchId || !task.remoteDataId) return
    const settings = await this.settingsService.get()
    const token = await this.vault.get('parser-token')
    if (!token) {
      await this.markTaskFailed(taskId, new Error('未配置 MinerU API Token'))
      return
    }
    try {
      const initial = await this.parserClient.getBatchResult(task.remoteBatchId, token)
      const entry = initial.entries.find((item) => item.dataId === task.remoteDataId)
      if (entry?.state === 'failed' || entry?.state === 'waiting-file') {
        this.logger.info('batch.retry-upload', { taskId, batchId: task.remoteBatchId, remoteState: entry.state })
        await this.clearRemoteTask(taskId)
        await this.processNewBatch([taskId])
        return
      }
      if (entry?.state === 'done') {
        await this.finishBatch(initial, new Set([taskId]), settings)
        return
      }
      const expected = new Set([task.remoteDataId])
      const finalResult = await this.parserClient.waitForBatch(
        task.remoteBatchId,
        token,
        expected,
        (result) => { void this.applyBatchProgress(result, new Set([taskId])) }
      )
      await this.finishBatch(finalResult, new Set([taskId]), settings)
    } catch (error) {
      if (error instanceof MinerUApiError && ['-60012', '-60013'].includes(String(error.code))) {
        await this.clearRemoteTask(taskId)
        await this.processNewBatch([taskId])
      } else {
        await this.markTaskFailed(taskId, error)
      }
    }
  }

  private async applyBatchProgress(result: BatchResult, taskIds: Set<string>): Promise<void> {
    const changedEntries: Array<{ dataId: string; state: string; progress: BatchResult['entries'][number]['progress'] }> = []
    for (const entry of result.entries) {
      if (!entry.dataId || !taskIds.has(entry.dataId)) continue
      const snapshot = JSON.stringify([entry.state, entry.progress])
      if (this.remoteSnapshots.get(entry.dataId) !== snapshot) {
        this.remoteSnapshots.set(entry.dataId, snapshot)
        changedEntries.push({ dataId: entry.dataId, state: entry.state, progress: entry.progress })
      }
      const task = await this.repository.getTask(entry.dataId)
      if (!task || ['completed', 'partial', 'failed'].includes(task.status)) continue
      if (entry.state === 'failed') continue
      const ratio = entry.progress ? entry.progress.extractedPages / entry.progress.totalPages : 0
      const progress =
        entry.state === 'waiting-file'
          ? 9
          : entry.state === 'done'
            ? 42
            : entry.state === 'converting'
              ? 40
              : entry.state === 'running'
                ? 12 + Math.round(ratio * 28)
                : 10
      const status = entry.state === 'waiting-file' ? 'uploading' : 'parsing'
      if (task.status !== status || task.progress !== progress || task.error !== null) {
        await this.repository.updateTask(task.id, { status, progress, error: null })
      }
    }
    if (changedEntries.length > 0) {
      this.logger.info('batch.polled', { batchId: result.batchId, entries: changedEntries })
      await this.emitTasks()
    }
  }

  private async finishBatch(result: BatchResult, taskIds: Set<string>, settings: Awaited<ReturnType<SettingsService['get']>>): Promise<void> {
    const entriesByDataId = new Map(result.entries.filter((entry) => entry.dataId).map((entry) => [entry.dataId!, entry]))
    await Promise.all(
      [...taskIds].map((taskId) => this.resultQueue.add(async () => {
        const entry = entriesByDataId.get(taskId)
        if (!entry) {
          await this.markTaskFailed(taskId, new Error('MinerU 批次结果缺少对应 data_id'))
          return
        }
        if (entry.state === 'failed') {
          await this.markTaskFailed(taskId, new Error(entry.error || 'MinerU 解析失败'))
          return
        }
        if (entry.state !== 'done' || !entry.fullZipUrl) {
          await this.markTaskFailed(taskId, new Error(`MinerU 返回未完成状态：${entry.state}`))
          return
        }
        try {
          await this.processParsedTask(taskId, entry.fullZipUrl, settings)
        } catch (error) {
          await this.markTaskFailed(taskId, error)
        }
      }))
    )
    await this.emitTasks()
  }

  private async processParsedTask(
    taskId: string,
    resultUrl: string,
    settings: Awaited<ReturnType<SettingsService['get']>>
  ): Promise<void> {
      const task = await this.repository.getTask(taskId)
      if (!task) return
      await this.repository.updateTask(taskId, { status: 'parsing', progress: 42, remoteResultUrl: resultUrl })
      this.logger.info('result.download-start', { taskId })
      const zip = await this.parserClient.downloadResult(resultUrl)
      const zipPath = join(task.outputDir, '.mineru-result.zip')
      const extractedDir = join(task.outputDir, '.parsed')
      await writeFile(zipPath, zip)
      await rm(extractedDir, { recursive: true, force: true })
      await extract(zipPath, { dir: extractedDir })
      await rm(zipPath, { force: true })
      await this.computeRequired().normalizeParserOutput(task, extractedDir)
      this.logger.info('result.normalized', { taskId })

      const markdown = await readFile(join(task.outputDir, 'full.md'), 'utf8')
      const mappings = await this.loadMappings(task)
      const namedTask = await this.applyParsedTitle(task, markdown, mappings)
      const providers = createTranslationProviders(settings, this.vault, this.fetcher)
      await this.repository.updateTask(taskId, { status: 'translating', progress: 45 })
      this.logger.info('translation.start', { taskId, preferredProvider: namedTask.translationProvider })
      await this.emitTasks()
      const result = await translateMarkdown({
        task: namedTask,
        markdown,
        mappings,
        providers,
        repository: this.repository,
        onProgress: (completed, total, failed) => {
          const progress = total === 0 ? 100 : 45 + Math.round(((completed + failed) / total) * 55)
          void Promise.resolve(this.repository.updateTranslationRun(taskId, total, completed, failed)).catch(() => undefined)
          void Promise.resolve(this.repository.updateTask(taskId, { status: 'translating', progress }))
            .then((updated) => { this.taskCache.set(taskId, updated) })
            .catch(() => undefined)
          void this.emitTasks().catch(() => undefined)
        }
      })
      await writeFile(join(namedTask.outputDir, 'full.zh-CN.md'), result.markdown, 'utf8')
      await this.recordArtifact(namedTask, 'translated_markdown', join(namedTask.outputDir, 'full.zh-CN.md'))
      await writeFile(
        join(namedTask.outputDir, 'translation.checkpoint.json'),
        JSON.stringify(
          {
            taskId,
            totalBlocks: result.blocks.length,
            completedBlocks: result.blocks.filter((block) => block.status === 'completed').length,
            failedBlockIds: result.failedBlockIds,
            updatedAt: new Date().toISOString()
          },
          null,
          2
        ),
        'utf8'
      )
      await this.writeManifest(namedTask, result)
      const updated = await this.repository.updateTask(taskId, {
        status: result.failedBlockIds.length > 0 ? 'partial' : 'completed',
        progress: 100,
        error: result.failedBlockIds.length > 0 ? `${result.failedBlockIds.length} 个区块翻译失败` : null
      })
      this.taskCache.set(taskId, updated)
      this.remoteSnapshots.delete(taskId)
      await this.emitTasks()
      this.emit('notification', taskId, result.failedBlockIds.length > 0 ? 'partial' : 'completed')
      this.logger.info('translation.completed', { taskId, failedBlocks: result.failedBlockIds.length })
  }

  private async applyParsedTitle(
    task: MinerUTask,
    markdown: string,
    mappings: BlockMapping[]
  ): Promise<MinerUTask> {
    const candidate = extractPaperTitle(markdown, mappings)
    const title = candidate ? sanitizeTitleStem(candidate) : null
    if (!title) {
      this.logger.info('result.title-skipped', { taskId: task.id, reason: 'empty-or-invalid-title' })
      return task
    }

    const name = `${title}.pdf`
    try {
      // The v2 storage path is an immutable UUID directory. Parsed titles are
      // display metadata only; changing them must never move an active job's
      // files or invalidate persisted artifact paths.
      const updated = await this.repository.updateTask(task.id, { title, name })
      this.taskCache.set(task.id, updated)
      return updated
    } catch (error) {
      this.logger.error('result.title-metadata-failed', error, { taskId: task.id })
      return task
    }
  }

  private async clearRemoteTask(taskId: string): Promise<void> {
    const updated = await this.repository.updateTask(taskId, {
      status: 'uploading',
      progress: 0,
      remoteBatchId: null,
      remoteDataId: null,
      remoteResultUrl: null,
      error: null
    })
    this.taskCache.set(taskId, updated)
  }

  private async markTaskFailed(taskId: string, error: unknown): Promise<void> {
    const task = await this.repository.getTask(taskId)
    if (!task) return
    const safeMessage = readableError(error)
    const updated = await this.repository.updateTask(taskId, { status: 'failed', error: safeMessage })
    this.taskCache.set(taskId, updated)
    this.remoteSnapshots.delete(taskId)
    this.logger.error('task.failed', new Error(safeMessage), { taskId })
    this.emit('notification', taskId, 'failed')
  }

  private async recordArtifact(task: MinerUTask, kind: ArtifactKind, path: string): Promise<void> {
    if (!this.repository.recordArtifactRevision) return
    await this.repository.recordArtifactRevision(task.id, kind, path, await this.computeRequired().hashFile(path))
  }

  private async loadMappings(task: MinerUTask): Promise<BlockMapping[]> {
    const blockPath = join(task.outputDir, 'block_list.json')
    try {
      const value = JSON.parse(await readFile(blockPath, 'utf8')) as { version?: number; mappings?: BlockMapping[]; pdfData?: unknown }
      if (value.version === BLOCK_MAPPING_VERSION && Array.isArray(value.mappings)) return value.mappings
      await this.computeRequired().rebuildMappings(task.id, task.outputDir)
      const rebuilt = JSON.parse(await readFile(blockPath, 'utf8')) as { mappings?: BlockMapping[] }
      return Array.isArray(rebuilt.mappings) ? rebuilt.mappings : []
    } catch {
      try {
        await this.computeRequired().rebuildMappings(task.id, task.outputDir)
        const rebuilt = JSON.parse(await readFile(blockPath, 'utf8')) as { mappings?: BlockMapping[] }
        return Array.isArray(rebuilt.mappings) ? rebuilt.mappings : []
      } catch {
        return []
      }
    }
  }

  private async loadTranslatedBlocks(task: MinerUTask): Promise<TranslatedMarkdownBlock[] | null> {
    try {
      const manifest = JSON.parse(await readFile(join(task.outputDir, 'translation.manifest.json'), 'utf8')) as any
      if (manifest?.version !== 2 || manifest.taskId !== task.id || !Array.isArray(manifest.blocks)) return null
      const blocks = manifest.blocks.map((block: any) => {
        if (
          !Number.isInteger(block?.sourceIndex) ||
          block.sourceIndex < 0 ||
          typeof block?.markdown !== 'string'
        ) return null
        return {
          sourceIndex: block.sourceIndex,
          markdown: block.markdown,
          mappingIds: Array.isArray(block.mappingIds) && block.mappingIds.every((id: unknown) => typeof id === 'string')
            ? [...block.mappingIds]
            : null
        }
      })
      if (blocks.some((block: unknown) => block === null)) return null
      const sourceIndexes = blocks.map((block: any) => block.sourceIndex)
      const validSourceOrder =
        new Set(sourceIndexes).size === sourceIndexes.length &&
        [...sourceIndexes].sort((left: number, right: number) => left - right)
          .every((sourceIndex: number, index: number) => sourceIndex === index)
      const ordered = validSourceOrder
        ? [...blocks].sort((left: any, right: any) => left.sourceIndex - right.sourceIndex)
        : blocks
      const trustMappings =
        validSourceOrder &&
        manifest.mappingAlgorithmVersion === MARKDOWN_MAPPING_ALGORITHM_VERSION &&
        ordered.every((block: any) => Array.isArray(block.mappingIds))
      return ordered.map(({ sourceIndex, markdown, mappingIds }: any) => ({
        sourceIndex,
        markdown,
        mappingIds: trustMappings ? mappingIds : []
      }))
    } catch {
      return null
    }
  }

  private async writeManifest(task: MinerUTask, result: TranslationResult): Promise<void> {
    await writeFile(
      join(task.outputDir, 'translation.manifest.json'),
      JSON.stringify(
        {
          version: 2,
          mappingAlgorithmVersion: MARKDOWN_MAPPING_ALGORITHM_VERSION,
          taskId: task.id,
          targetLanguage: 'zh-CN',
          preferredProvider: task.translationProvider,
          translationPipelineVersion: TRANSLATION_PIPELINE_VERSION,
          tableTranslationProtocol: TABLE_TRANSLATION_PROTOCOL,
          failedBlockIds: result.failedBlockIds,
          blocks: result.blocks.map(({ blockId, sourceIndex, mappingIds, sourceHash, markdown, provider, model, status, error }) => ({
            blockId,
            sourceIndex,
            mappingIds,
            sourceHash,
            markdown,
            provider,
            model,
            status,
            error
          }))
        },
        null,
        2
      ),
      'utf8'
    )
    await this.recordArtifact(task, 'manifest', join(task.outputDir, 'translation.manifest.json'))
  }

  private async emitTasks(): Promise<void> {
    this.emit('changed', await this.list())
  }

  private computeRequired(): TaskComputePort {
    if (!this.compute) throw new Error('核心计算服务尚未初始化')
    return this.compute
  }

}

async function readOptional(path: string, fallback = ''): Promise<string> {
  try {
    await access(path)
    return await readFile(path, 'utf8')
  } catch {
    return fallback
  }
}

function readableError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw
    .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/giu, '[REDACTED]')
    .replace(/\b(?:api[-_ ]?key|token|secret|password)\b\s*[:=]\s*[^\s,;]+/giu, '[REDACTED]')
    .replace(/([?&](?:token|api[-_]?key|key|signature)=)[^&\s]+/giu, '$1[REDACTED]')
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s"'<>]+/gu, '[path]')
    .replace(/(^|[\s('"`])\/(?:[^\s/'"`]+\/)+[^\s)'"`,;]*/gu, '$1[path]')
    .slice(0, 4_096)
}

function isTaskComputePort(value: unknown): value is TaskComputePort {
  return Boolean(value && typeof value === 'object' && typeof (value as { hashFile?: unknown }).hashFile === 'function')
}

function isPathPolicyPort(value: unknown): value is PathPolicyPort {
  return Boolean(value && typeof value === 'object' && typeof (value as { resolveChild?: unknown }).resolveChild === 'function')
}

export function splitIntoMinerUBatches<T>(values: T[], size: number): T[][] {
  const groups: T[][] = []
  for (let index = 0; index < values.length; index += size) groups.push(values.slice(index, index + size))
  return groups
}
