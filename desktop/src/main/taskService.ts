import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
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
import type { TaskRepository } from './database'
import type { CredentialVault } from './credentialVault'
import type { SettingsService } from './settingsService'
import type { MinerUApiV2Client, ParseSubmission } from './parserClient'
import { buildBlockMappings } from './blockMapping'
import { createTranslationProviders } from './translation/providers'
import { translateMarkdown } from './translation/markdownPipeline'

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export class TaskService extends EventEmitter {
  private readonly queue = new PQueue({ concurrency: 3 })

  constructor(
    private readonly repository: TaskRepository,
    private readonly settingsService: SettingsService,
    private readonly vault: CredentialVault,
    private readonly parserClient: MinerUApiV2Client,
    private readonly fetcher: Fetcher
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
        remoteTaskId: null,
        remoteStatusUrl: null,
        remoteResultUrl: null,
        error: null,
        createdAt: now,
        updatedAt: now
      }
      this.repository.insertTask(task)
      created.push(task)
      this.enqueue(id)
    }
    this.emitTasks()
    return created
  }

  retry(taskId: string): void {
    const task = this.repository.getTask(taskId)
    if (!task) throw new Error('任务不存在')
    this.repository.updateTask(taskId, { status: task.remoteTaskId ? 'parsing' : 'uploading', error: null })
    this.emitTasks()
    this.enqueue(taskId)
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

  private enqueue(taskId: string): void {
    void this.queue.add(() => this.process(taskId))
  }

  private async process(taskId: string): Promise<void> {
    let task = this.repository.getTask(taskId)
    if (!task) return
    try {
      const settings = await this.settingsService.get()
      const token = await this.vault.get('parser-token')
      let submission: ParseSubmission
      if (task.remoteTaskId && task.remoteStatusUrl && task.remoteResultUrl) {
        submission = {
          taskId: task.remoteTaskId,
          statusUrl: task.remoteStatusUrl,
          resultUrl: task.remoteResultUrl
        }
      } else {
        submission = await this.parserClient.submit(task, settings, token)
        task = this.repository.updateTask(taskId, {
          status: 'parsing',
          progress: 10,
          remoteTaskId: submission.taskId,
          remoteStatusUrl: submission.statusUrl,
          remoteResultUrl: submission.resultUrl
        })
        this.emitTasks()
      }

      await this.parserClient.waitForCompletion(submission, token)
      this.repository.updateTask(taskId, { status: 'parsing', progress: 42 })
      this.emitTasks()
      const zip = await this.parserClient.downloadResult(submission.resultUrl, token)
      const zipPath = join(task.outputDir, '.mineru-result.zip')
      const extractedDir = join(task.outputDir, '.parsed')
      await writeFile(zipPath, zip)
      await rm(extractedDir, { recursive: true, force: true })
      await extract(zipPath, { dir: extractedDir })
      await rm(zipPath, { force: true })
      await this.normalizeParserOutput(task, extractedDir)

      const markdown = await readFile(join(task.outputDir, 'full.md'), 'utf8')
      const mappings = await this.loadMappings(task)
      const providers = createTranslationProviders(settings, this.vault, this.fetcher)
      this.repository.updateTask(taskId, { status: 'translating', progress: 45 })
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
      this.emitTasks()
      this.emit('notification', taskId, result.failedBlockIds.length > 0 ? 'partial' : 'completed')
    } catch (error) {
      this.repository.updateTask(taskId, { status: 'failed', error: readableError(error) })
      this.emitTasks()
      this.emit('notification', taskId, 'failed')
    }
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
    await writeFile(join(task.outputDir, 'block_list.json'), JSON.stringify({ mappings }, null, 2), 'utf8')
  }

  private async loadMappings(task: MinerUTask): Promise<BlockMapping[]> {
    const blockPath = join(task.outputDir, 'block_list.json')
    try {
      const value = JSON.parse(await readFile(blockPath, 'utf8')) as { mappings?: BlockMapping[] }
      if (Array.isArray(value.mappings)) return value.mappings
      return buildBlockMappings(task.id, value)
    } catch {
      try {
        const layout = JSON.parse(await readFile(join(task.outputDir, 'layout.json'), 'utf8'))
        return buildBlockMappings(task.id, layout)
      } catch {
        return []
      }
    }
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
  return createHash('sha256').update(await readFile(path)).digest('hex')
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
