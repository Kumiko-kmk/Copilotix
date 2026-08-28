import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import {
  access,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
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
} from '@shared/types'
import { MAX_PDF_BYTES, MINERU_BATCH_SIZE } from '@shared/constants'
import type { TaskRepository } from './database'
import type { CredentialVault } from './credentialVault'
import type { SettingsService } from './settingsService'
import { MinerUApiError, type BatchResult, type MinerUClient } from './parserClient'
import { BLOCK_MAPPING_VERSION, buildBlockMappings } from './blockMapping'
import { createTranslationProviders } from './translation/providers'
import { translateMarkdown } from './translation/markdownPipeline'
import type { TaskLogger } from './logger'

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

const silentLogger: TaskLogger = {
  info: () => undefined,
  error: () => undefined
}

export class TaskService extends EventEmitter {
  private readonly queue = new PQueue({ concurrency: 2 })
  private readonly resultQueue = new PQueue({ concurrency: 3 })
  private readonly remoteSnapshots = new Map<string, string>()

  constructor(
    private readonly repository: TaskRepository,
    private readonly settingsService: SettingsService,
    private readonly vault: CredentialVault,
    private readonly parserClient: MinerUClient,
    private readonly fetcher: Fetcher,
    private readonly logger: TaskLogger = silentLogger
  ) {
    super()
  }

  list(): MinerUTask[] {
    return this.repository.listTasks()
  }

  async inspectPdfs(paths: string[]): Promise<SelectedPdf[]> {
    return Promise.all(
      paths.map(async (path) => {
        const info = await stat(path)
        const hash = await hashFile(path)
        return {
          path,
          name: basename(path),
          size: info.size,
          duplicateTask: this.repository.findByHash(hash) ?? undefined
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
    const created: MinerUTask[] = []
    for (const file of request.files) {
      if (extname(file.path).toLowerCase() !== '.pdf') continue
      const sourceHash = await hashFile(file.path)
      if (!request.createDuplicates && this.repository.findByHash(sourceHash)) continue
      const id = uuidv4()
      const outputDir = join(settings.outputRoot, `${sanitizeFileName(basename(file.name, '.pdf'))}-${id}`)
      await mkdir(outputDir, { recursive: true })
      const localPdf = join(outputDir, 'original.pdf')
      await copyFile(file.path, localPdf)
      const now = new Date().toISOString()
      const task: MinerUTask = {
        id,
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
    this.repository.insertTasks(created)
    for (const batch of splitIntoMinerUBatches(created, MINERU_BATCH_SIZE)) this.enqueueBatch(batch.map((task) => task.id))
    this.emitTasks()
    return created
  }

  retry(taskId: string): void {
    const task = this.repository.getTask(taskId)
    if (!task) throw new Error('任务不存在')
    this.repository.updateTask(taskId, { status: task.remoteBatchId ? 'parsing' : 'uploading', error: null })
    this.emitTasks()
    if (task.remoteBatchId && task.remoteDataId) this.enqueueResume(taskId)
    else this.enqueueBatch([taskId])
  }

  async delete(taskId: string, deleteFiles: boolean): Promise<void> {
    const task = this.repository.getTask(taskId)
    if (!task) return
    if (deleteFiles) {
      const settings = await this.settingsService.get()
      const root = resolve(settings.outputRoot)
      const target = resolve(task.outputDir)
      if (target === root || !target.startsWith(`${root}\\`)) throw new Error('拒绝删除输出根目录以外的路径')
      await rm(target, { recursive: true, force: true })
    }
    this.repository.deleteTask(taskId)
    this.emitTasks()
  }

  async getDocument(taskId: string): Promise<DocumentPayload> {
    const task = this.repository.getTask(taskId)
    if (!task) throw new Error('任务不存在')
    const markdown = await readOptional(join(task.outputDir, 'full.md'))
    const translatedMarkdown = await readOptional(join(task.outputDir, 'full.zh-CN.md'))
    const layoutJson = await readOptional(join(task.outputDir, 'layout.json'), '{}')
    const mappings = await this.loadMappings(task)
    return {
      task,
      markdown,
      translatedMarkdown,
      layoutJson,
      mappings,
      pdfUrl: `mineru-asset://${task.id}/original.pdf`,
      assetBaseUrl: `mineru-asset://${task.id}/`
    }
  }

  resolveAsset(taskId: string, assetPath: string): string {
    const task = this.repository.getTask(taskId)
    if (!task) throw new Error('任务不存在')
    const root = resolve(task.outputDir)
    const target = resolve(root, decodeURIComponent(assetPath.replace(/^\/+/, '')))
    if (target !== root && !target.startsWith(`${root}\\`)) throw new Error('非法资源路径')
    return target
  }

  async createResultZip(taskId: string, destination: string): Promise<void> {
    const task = this.repository.getTask(taskId)
    if (!task) throw new Error('任务不存在')
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
    const tasks = taskIds.map((taskId) => this.repository.getTask(taskId)).filter((task): task is MinerUTask => Boolean(task))
    if (tasks.length === 0) return
    this.logger.info('batch.start', { taskIds })
    try {
      const settings = await this.settingsService.get()
      const token = await this.vault.get('parser-token')
      if (!token) throw new Error('未配置 MinerU API Token')
      const submission = await this.parserClient.createUploadBatch(tasks, settings, token)
      this.logger.info('batch.created', { batchId: submission.batchId, taskIds })
      for (const upload of submission.uploads) {
        this.repository.updateTask(upload.taskId, {
          status: 'uploading',
          progress: 1,
          remoteBatchId: submission.batchId,
          remoteDataId: upload.dataId,
          remoteResultUrl: null,
          error: null
        })
      }
      this.emitTasks()

      const uploadedTaskIds = new Set<string>()
      const uploadQueue = new PQueue({ concurrency: 3 })
      await Promise.all(
        submission.uploads.map((upload) => uploadQueue.add(async () => {
          const task = this.repository.getTask(upload.taskId)
          if (!task) return
          let lastProgress = -1
          try {
            this.logger.info('upload.start', { taskId: task.id, batchId: submission.batchId, bytes: (await stat(task.sourcePath)).size })
            await this.parserClient.uploadFile(task.sourcePath, upload.uploadUrl, (sent, total) => {
              const progress = Math.min(8, Math.max(1, Math.round((sent / total) * 8)))
              if (progress === lastProgress) return
              lastProgress = progress
              this.repository.updateTask(task.id, { status: 'uploading', progress })
              this.emitTasks()
            })
            uploadedTaskIds.add(task.id)
            this.repository.updateTask(task.id, { status: 'parsing', progress: 10 })
            this.logger.info('upload.completed', { taskId: task.id, batchId: submission.batchId })
          } catch (error) {
            this.logger.error('upload.failed', error, { taskId: task.id, batchId: submission.batchId })
            this.markTaskFailed(task.id, error)
          }
        }))
      )
      this.emitTasks()
      if (uploadedTaskIds.size === 0) return

      const finalResult = await this.parserClient.waitForBatch(
        submission.batchId,
        token,
        uploadedTaskIds,
        (result) => this.applyBatchProgress(result, uploadedTaskIds)
      )
      await this.finishBatch(finalResult, uploadedTaskIds, settings)
    } catch (error) {
      this.logger.error('batch.failed', error, { taskIds })
      for (const task of tasks) {
        const current = this.repository.getTask(task.id)
        if (current && !['completed', 'partial', 'failed'].includes(current.status)) this.markTaskFailed(task.id, error)
      }
      this.emitTasks()
    }
  }

  private async resumeTask(taskId: string): Promise<void> {
    const task = this.repository.getTask(taskId)
    if (!task?.remoteBatchId || !task.remoteDataId) return
    const settings = await this.settingsService.get()
    const token = await this.vault.get('parser-token')
    if (!token) {
      this.markTaskFailed(taskId, new Error('未配置 MinerU API Token'))
      return
    }
    try {
      const initial = await this.parserClient.getBatchResult(task.remoteBatchId, token)
      const entry = initial.entries.find((item) => item.dataId === task.remoteDataId)
      if (entry?.state === 'failed' || entry?.state === 'waiting-file') {
        this.logger.info('batch.retry-upload', { taskId, batchId: task.remoteBatchId, remoteState: entry.state })
        this.clearRemoteTask(taskId)
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
        (result) => this.applyBatchProgress(result, new Set([taskId]))
      )
      await this.finishBatch(finalResult, new Set([taskId]), settings)
    } catch (error) {
      if (error instanceof MinerUApiError && ['-60012', '-60013'].includes(String(error.code))) {
        this.clearRemoteTask(taskId)
        await this.processNewBatch([taskId])
      } else {
        this.markTaskFailed(taskId, error)
      }
    }
  }

  private applyBatchProgress(result: BatchResult, taskIds: Set<string>): void {
    const changedEntries: Array<{ dataId: string; state: string; progress: BatchResult['entries'][number]['progress'] }> = []
    for (const entry of result.entries) {
      if (!entry.dataId || !taskIds.has(entry.dataId)) continue
      const snapshot = JSON.stringify([entry.state, entry.progress])
      if (this.remoteSnapshots.get(entry.dataId) !== snapshot) {
        this.remoteSnapshots.set(entry.dataId, snapshot)
        changedEntries.push({ dataId: entry.dataId, state: entry.state, progress: entry.progress })
      }
      const task = this.repository.getTask(entry.dataId)
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
        this.repository.updateTask(task.id, { status, progress, error: null })
      }
    }
    if (changedEntries.length > 0) {
      this.logger.info('batch.polled', { batchId: result.batchId, entries: changedEntries })
      this.emitTasks()
    }
  }

  private async finishBatch(result: BatchResult, taskIds: Set<string>, settings: Awaited<ReturnType<SettingsService['get']>>): Promise<void> {
    const entriesByDataId = new Map(result.entries.filter((entry) => entry.dataId).map((entry) => [entry.dataId!, entry]))
    await Promise.all(
      [...taskIds].map((taskId) => this.resultQueue.add(async () => {
        const entry = entriesByDataId.get(taskId)
        if (!entry) {
          this.markTaskFailed(taskId, new Error('MinerU 批次结果缺少对应 data_id'))
          return
        }
        if (entry.state === 'failed') {
          this.markTaskFailed(taskId, new Error(entry.error || 'MinerU 解析失败'))
          return
        }
        if (entry.state !== 'done' || !entry.fullZipUrl) {
          this.markTaskFailed(taskId, new Error(`MinerU 返回未完成状态：${entry.state}`))
          return
        }
        try {
          await this.processParsedTask(taskId, entry.fullZipUrl, settings)
        } catch (error) {
          this.markTaskFailed(taskId, error)
        }
      }))
    )
    this.emitTasks()
  }

  private async processParsedTask(
    taskId: string,
    resultUrl: string,
    settings: Awaited<ReturnType<SettingsService['get']>>
  ): Promise<void> {
      const task = this.repository.getTask(taskId)
      if (!task) return
      this.repository.updateTask(taskId, { status: 'parsing', progress: 42, remoteResultUrl: resultUrl })
      this.logger.info('result.download-start', { taskId })
      const zip = await this.parserClient.downloadResult(resultUrl)
      const zipPath = join(task.outputDir, '.mineru-result.zip')
      const extractedDir = join(task.outputDir, '.parsed')
      await writeFile(zipPath, zip)
      await rm(extractedDir, { recursive: true, force: true })
      await extract(zipPath, { dir: extractedDir })
      await rm(zipPath, { force: true })
      await this.normalizeParserOutput(task, extractedDir)
      this.logger.info('result.normalized', { taskId })

      const markdown = await readFile(join(task.outputDir, 'full.md'), 'utf8')
      const mappings = await this.loadMappings(task)
      const providers = createTranslationProviders(settings, this.vault, this.fetcher)
      this.repository.updateTask(taskId, { status: 'translating', progress: 45 })
      this.logger.info('translation.start', { taskId, preferredProvider: task.translationProvider })
      this.emitTasks()
      const result = await translateMarkdown({
        task,
        markdown,
        mappings,
        providers,
        repository: this.repository,
        onProgress: (completed, total, failed) => {
          const progress = total === 0 ? 100 : 45 + Math.round(((completed + failed) / total) * 55)
          this.repository.updateTranslationRun(taskId, total, completed, failed)
          this.repository.updateTask(taskId, { status: 'translating', progress })
          this.emitTasks()
        }
      })
      await writeFile(join(task.outputDir, 'full.zh-CN.md'), result.markdown, 'utf8')
      await writeFile(
        join(task.outputDir, 'translation.checkpoint.json'),
        JSON.stringify(
          {
            taskId,
            totalBlocks: mappings.length,
            failedBlockIds: result.failedBlockIds,
            updatedAt: new Date().toISOString()
          },
          null,
          2
        ),
        'utf8'
      )
      await this.writeManifest(task, result.failedBlockIds)
      this.repository.updateTask(taskId, {
        status: result.failedBlockIds.length > 0 ? 'partial' : 'completed',
        progress: 100,
        error: result.failedBlockIds.length > 0 ? `${result.failedBlockIds.length} 个区块翻译失败` : null
      })
      this.remoteSnapshots.delete(taskId)
      this.emitTasks()
      this.emit('notification', taskId, result.failedBlockIds.length > 0 ? 'partial' : 'completed')
      this.logger.info('translation.completed', { taskId, failedBlocks: result.failedBlockIds.length })
  }

  private clearRemoteTask(taskId: string): void {
    this.repository.updateTask(taskId, {
      status: 'uploading',
      progress: 0,
      remoteBatchId: null,
      remoteDataId: null,
      remoteResultUrl: null,
      error: null
    })
  }

  private markTaskFailed(taskId: string, error: unknown): void {
    const task = this.repository.getTask(taskId)
    if (!task) return
    this.repository.updateTask(taskId, { status: 'failed', error: readableError(error) })
    this.remoteSnapshots.delete(taskId)
    this.logger.error('task.failed', error, { taskId })
    this.emit('notification', taskId, 'failed')
  }

  private async normalizeParserOutput(task: MinerUTask, extractedDir: string): Promise<void> {
    const files = await walkFiles(extractedDir)
    const markdown = chooseFile(files, (path) => extname(path).toLowerCase() === '.md')
    const layout = chooseFile(files, (path) => /(?:layout|middle)\.json$/i.test(path))
    const contentList = chooseFile(files, (path) => /content_list(?:_v2)?\.json$/i.test(path))
    if (!markdown) throw new Error('MinerU 结果中缺少 Markdown 文件')
    if (!layout) throw new Error('MinerU 结果中缺少 middle/layout JSON')
    await copyFile(markdown, join(task.outputDir, 'full.md'))
    await copyFile(layout, join(task.outputDir, 'layout.json'))
    if (contentList) await copyFile(contentList, join(task.outputDir, 'content_list.json'))

    for (const file of files) {
      const rel = relative(extractedDir, file)
      if (!/[/\\]images?[/\\]/i.test(file) && !/\.(png|jpe?g|webp|gif|svg)$/i.test(file)) continue
      const target = join(task.outputDir, rel)
      await mkdir(dirname(target), { recursive: true })
      await copyFile(file, target)
    }
    const layoutData = JSON.parse(await readFile(join(task.outputDir, 'layout.json'), 'utf8'))
    const mappings = buildBlockMappings(task.id, layoutData)
    await writeFile(
      join(task.outputDir, 'block_list.json'),
      JSON.stringify({ version: BLOCK_MAPPING_VERSION, mappings }, null, 2),
      'utf8'
    )
  }

  private async loadMappings(task: MinerUTask): Promise<BlockMapping[]> {
    const blockPath = join(task.outputDir, 'block_list.json')
    try {
      const value = JSON.parse(await readFile(blockPath, 'utf8')) as { version?: number; mappings?: BlockMapping[]; pdfData?: unknown }
      if (value.version === BLOCK_MAPPING_VERSION && Array.isArray(value.mappings)) return value.mappings
      if (Array.isArray(value.pdfData)) return buildBlockMappings(task.id, value)
      return await this.rebuildMappings(task, blockPath)
    } catch {
      try {
        return await this.rebuildMappings(task, blockPath)
      } catch {
        return []
      }
    }
  }

  private async rebuildMappings(task: MinerUTask, blockPath: string): Promise<BlockMapping[]> {
    const layout = JSON.parse(await readFile(join(task.outputDir, 'layout.json'), 'utf8'))
    const mappings = buildBlockMappings(task.id, layout)
    await writeFile(blockPath, JSON.stringify({ version: BLOCK_MAPPING_VERSION, mappings }, null, 2), 'utf8')
    return mappings
  }

  private async writeManifest(task: MinerUTask, failedBlockIds: string[]): Promise<void> {
    const blocks = this.repository.listTranslationBlocks(task.id)
    await writeFile(
      join(task.outputDir, 'translation.manifest.json'),
      JSON.stringify(
        {
          version: 1,
          taskId: task.id,
          targetLanguage: 'zh-CN',
          preferredProvider: task.translationProvider,
          failedBlockIds,
          blocks: blocks.map(({ blockId, sourceHash, provider, model, status, error }) => ({
            blockId,
            sourceHash,
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
  }

  private emitTasks(): void {
    this.emit('changed', this.list())
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolvePromise, reject) => {
    const input = createReadStream(path)
    input.on('data', (chunk) => hash.update(chunk))
    input.on('end', resolvePromise)
    input.on('error', reject)
  })
  return hash.digest('hex')
}

function sanitizeFileName(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').slice(0, 100) || 'document'
}

async function walkFiles(root: string): Promise<string[]> {
  const result: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) result.push(...(await walkFiles(path)))
    else if (entry.isFile()) result.push(path)
  }
  return result
}

function chooseFile(files: string[], predicate: (path: string) => boolean): string | null {
  return files.find((path) => predicate(path)) ?? null
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
  return error instanceof Error ? error.message : String(error)
}

export function splitIntoMinerUBatches<T>(values: T[], size: number): T[][] {
  const groups: T[][] = []
  for (let index = 0; index < values.length; index += size) groups.push(values.slice(index, index + size))
  return groups
}
