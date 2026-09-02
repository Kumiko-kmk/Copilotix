import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import archiver from 'archiver'
import extractZip from 'extract-zip'
import { afterEach, describe, expect, it } from 'vitest'
import { TaskRepository } from '@main/database'
import type { CredentialAccount, CredentialVault } from '@main/credentialVault'
import type { BatchResult, BatchSubmission, MinerUClient } from '@main/parserClient'
import { SettingsService } from '@main/settingsService'
import { TaskService } from '@main/taskService'
import { MARKDOWN_MAPPING_ALGORITHM_VERSION } from '@shared/markdownBlocks'
import type { AppSettings, HealthResult, MinerUTask } from '@shared/types'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('TaskService official MinerU batches', () => {
  it('continues polling uploaded files when another file in the batch fails to upload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mineru-task-service-'))
    temporaryRoots.push(root)
    const firstPdf = join(root, 'first.pdf')
    const secondPdf = join(root, 'second.pdf')
    await Promise.all([writeFile(firstPdf, '%PDF-1.4 first'), writeFile(secondPdf, '%PDF-1.4 second')])

    const repository = new TaskRepository(join(root, 'tasks.sqlite3'))
    const vault = new MemoryVault({ 'parser-token': 'test-token' })
    const settings = new SettingsService(repository, vault, join(root, 'output'))
    const client = new PartiallyFailingClient()
    const service = new TaskService(repository, settings, vault, client, async () => new Response())

    try {
      const created = await service.create({
        files: [
          { path: firstPdf, name: 'first.pdf', size: 14 },
          { path: secondPdf, name: 'second.pdf', size: 15 }
        ],
        parserModel: 'vlm',
        translationProvider: 'qwen',
        createDuplicates: false
      })
      await waitFor(() => repository.listTasks().every((task) => task.status === 'failed'))

      expect(created).toHaveLength(2)
      expect(created[0]).toMatchObject({ originalName: 'first.pdf', title: null, name: 'first.pdf' })
      expect(client.uploadedDataIds).toHaveLength(2)
      expect(client.polledDataIds).toEqual([created[1]!.id])
      expect(repository.getTask(created[0]!.id)?.error).toContain('fixture upload failed')
      expect(repository.getTask(created[1]!.id)?.error).toContain('fixture parse failed')
    } finally {
      repository.close()
    }
  })

  it('trusts only ordered translated blocks written by the current mapping algorithm', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mineru-translation-manifest-'))
    temporaryRoots.push(root)
    const outputDir = join(root, 'task-output')
    await mkdir(outputDir, { recursive: true })
    await Promise.all([
      writeFile(join(outputDir, 'full.md'), '# Title\n\nAuthors\n\nAbstract\n', 'utf8'),
      writeFile(join(outputDir, 'full.zh-CN.md'), '# 标题\n作者\n摘要\n', 'utf8'),
      writeFile(join(outputDir, 'layout.json'), '{"pdf_info":[]}', 'utf8')
    ])

    const repository = new TaskRepository(join(root, 'tasks.sqlite3'))
    const now = new Date().toISOString()
    const fixtureTask: MinerUTask = {
      id: 'translated-task',
      originalName: 'paper.pdf',
      title: null,
      name: 'paper.pdf',
      sourcePath: join(root, 'paper.pdf'),
      sourceHash: 'fixture-hash',
      outputDir,
      status: 'completed',
      progress: 100,
      parserModel: 'vlm',
      translationProvider: 'qwen',
      remoteBatchId: null,
      remoteDataId: null,
      remoteResultUrl: null,
      error: null,
      createdAt: now,
      updatedAt: now
    }
    repository.insertTasks([fixtureTask])
    const vault = new MemoryVault({})
    const settings = new SettingsService(repository, vault, join(root, 'output'))
    const service = new TaskService(repository, settings, vault, new PartiallyFailingClient(), async () => new Response())

    try {
      await writeFile(join(outputDir, 'translation.manifest.json'), JSON.stringify({
        version: 2,
        mappingAlgorithmVersion: MARKDOWN_MAPPING_ALGORITHM_VERSION,
        taskId: fixtureTask.id,
        blocks: [
          { sourceIndex: 1, markdown: '作者', mappingIds: ['authors'] },
          { sourceIndex: 0, markdown: '# 标题', mappingIds: ['title'] },
          { sourceIndex: 2, markdown: '摘要', mappingIds: ['abstract'] }
        ]
      }), 'utf8')
      const current = await service.getDocument(fixtureTask.id)
      expect(current.translatedBlocks).toEqual([
        { sourceIndex: 0, markdown: '# 标题', mappingIds: ['title'] },
        { sourceIndex: 1, markdown: '作者', mappingIds: ['authors'] },
        { sourceIndex: 2, markdown: '摘要', mappingIds: ['abstract'] }
      ])

      await writeFile(join(outputDir, 'translation.manifest.json'), JSON.stringify({
        version: 2,
        taskId: fixtureTask.id,
        blocks: [
          { sourceIndex: 1, markdown: '作者', mappingIds: ['wrong-authors'] },
          { sourceIndex: 0, markdown: '# 标题', mappingIds: ['wrong-title'] },
          { sourceIndex: 2, markdown: '摘要', mappingIds: ['wrong-abstract'] }
        ]
      }), 'utf8')
      const oldMapping = await service.getDocument(fixtureTask.id)
      expect(oldMapping.translatedBlocks).toEqual([
        { sourceIndex: 0, markdown: '# 标题', mappingIds: [] },
        { sourceIndex: 1, markdown: '作者', mappingIds: [] },
        { sourceIndex: 2, markdown: '摘要', mappingIds: [] }
      ])

      await writeFile(join(outputDir, 'translation.manifest.json'), JSON.stringify({
        version: 2,
        mappingAlgorithmVersion: MARKDOWN_MAPPING_ALGORITHM_VERSION,
        taskId: fixtureTask.id,
        blocks: [
          { sourceIndex: 0, markdown: '# 标题', mappingIds: ['title'] },
          { sourceIndex: 0, markdown: '重复索引', mappingIds: ['wrong'] },
          { sourceIndex: 2, markdown: '摘要', mappingIds: ['abstract'] }
        ]
      }), 'utf8')
      const malformed = await service.getDocument(fixtureTask.id)
      expect(malformed.translatedBlocks).toEqual([
        { sourceIndex: 0, markdown: '# 标题', mappingIds: [] },
        { sourceIndex: 0, markdown: '重复索引', mappingIds: [] },
        { sourceIndex: 2, markdown: '摘要', mappingIds: [] }
      ])

      await writeFile(join(outputDir, 'translation.manifest.json'), JSON.stringify({ version: 1 }), 'utf8')
      const legacy = await service.getDocument(fixtureTask.id)
      expect(legacy.translatedBlocks).toBeNull()
      expect(legacy.translatedMarkdown).toContain('作者')
    } finally {
      repository.close()
    }
  })

  it('updates a parsed task title without renaming its stable output directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mineru-title-integration-'))
    temporaryRoots.push(root)
    const outputRoot = join(root, 'output')
    const oldOutputDir = join(outputRoot, 'uploaded-name-parse-task')
    const originalPdf = join(oldOutputDir, 'original.pdf')
    await mkdir(oldOutputDir, { recursive: true })
    await writeFile(originalPdf, '%PDF-1.4 fixture')

    const repository = new TaskRepository(join(root, 'tasks.sqlite3'))
    const now = new Date().toISOString()
    const fixtureTask: MinerUTask = {
      id: 'parse-task',
      originalName: 'uploaded-name.pdf',
      title: null,
      name: 'uploaded-name.pdf',
      sourcePath: originalPdf,
      sourceHash: 'fixture-hash',
      outputDir: oldOutputDir,
      status: 'parsing',
      progress: 42,
      parserModel: 'vlm',
      translationProvider: 'qwen',
      remoteBatchId: 'batch-fixture',
      remoteDataId: 'parse-task',
      remoteResultUrl: null,
      error: null,
      createdAt: now,
      updatedAt: now
    }
    repository.insertTask(fixtureTask)
    const vault = new MemoryVault({ 'qwen-api-key': 'fixture-key' })
    const settings = new SettingsService(repository, vault, outputRoot)
    const client = new ParsedResultClient(await createResultZip({
      'result/full.md': '# Attention Is All You Need\n\nThis is a fixture paragraph.\n',
      'result/middle.json': JSON.stringify({
        pdf_info: [{
          page_idx: 0,
          page_size: [612, 792],
          para_blocks: [{
            index: 0,
            type: 'title',
            bbox: [40, 40, 500, 70],
            lines: [{ bbox: [40, 40, 500, 70], spans: [{ content: 'Attention Is All You Need' }] }]
          }, {
            index: 1,
            type: 'text',
            bbox: [40, 100, 500, 140],
            lines: [{ bbox: [40, 100, 500, 140], spans: [{ content: 'This is a fixture paragraph.' }] }]
          }]
        }]
      })
    }))
    const service = new TaskService(repository, settings, vault, client, async () => new Response(JSON.stringify({
      choices: [{ message: { content: '这是一个测试段落。' } }]
    }), { status: 200 }))

    try {
      const processParsedTask = (service as unknown as {
        processParsedTask(taskId: string, resultUrl: string, settings: AppSettings): Promise<void>
      }).processParsedTask.bind(service)
      await processParsedTask(fixtureTask.id, 'https://cdn.example.test/result.zip', await settings.get())

      const task = repository.getTask(fixtureTask.id)
      const expectedDir = oldOutputDir
      expect(task).toMatchObject({
        originalName: 'uploaded-name.pdf',
        title: 'Attention Is All You Need',
        name: 'Attention Is All You Need.pdf',
        outputDir: expectedDir,
        sourcePath: join(expectedDir, 'original.pdf'),
        status: 'completed'
      })
      await expect(access(oldOutputDir)).resolves.toBeUndefined()
      await expect(readFile(join(expectedDir, 'original.pdf'), 'utf8')).resolves.toBe('%PDF-1.4 fixture')
      await expect(readFile(join(expectedDir, 'full.md'), 'utf8')).resolves.toContain('# Attention Is All You Need')
      await expect(readFile(join(expectedDir, 'full.zh-CN.md'), 'utf8')).resolves.toContain('这是一个测试段落。')
      await expect(service.getDocument(fixtureTask.id)).resolves.toMatchObject({
        pdfUrl: 'mineru-asset://parse-task/original.pdf',
        task: { name: 'Attention Is All You Need.pdf' }
      })

      await processParsedTask(fixtureTask.id, 'https://cdn.example.test/result.zip', await settings.get())
      expect(repository.getTask(fixtureTask.id)?.outputDir).toBe(expectedDir)
      expect(repository.getTask(fixtureTask.id)?.name).toBe('Attention Is All You Need.pdf')

      const resultZipPath = join(root, 'result.zip')
      const extractedZipDir = join(root, 'exported-result')
      await service.createResultZip(fixtureTask.id, resultZipPath)
      await extractZip(resultZipPath, { dir: extractedZipDir })
      await expect(readFile(join(extractedZipDir, 'original.pdf'), 'utf8')).resolves.toBe('%PDF-1.4 fixture')
    } finally {
      repository.close()
    }
  })

  it('keeps the original directory and leaves unrelated title-like directories untouched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mineru-title-rename-failure-'))
    temporaryRoots.push(root)
    const outputRoot = join(root, 'output')
    const oldOutputDir = join(outputRoot, 'uploaded-name-rename-failure')
    const targetOutputDir = join(outputRoot, 'Safe Title-rename-failure-task')
    await mkdir(oldOutputDir, { recursive: true })
    await mkdir(targetOutputDir, { recursive: true })
    await writeFile(join(targetOutputDir, 'sentinel.txt'), 'keep this directory')
    const originalPdf = join(oldOutputDir, 'original.pdf')
    await writeFile(originalPdf, '%PDF-1.4 fixture')

    const repository = new TaskRepository(join(root, 'tasks.sqlite3'))
    const now = new Date().toISOString()
    const fixtureTask: MinerUTask = {
      id: 'rename-failure-task',
      originalName: 'uploaded-name.pdf',
      title: null,
      name: 'uploaded-name.pdf',
      sourcePath: originalPdf,
      sourceHash: 'fixture-hash',
      outputDir: oldOutputDir,
      status: 'parsing',
      progress: 42,
      parserModel: 'vlm',
      translationProvider: 'qwen',
      remoteBatchId: 'batch-fixture',
      remoteDataId: 'rename-failure-task',
      remoteResultUrl: null,
      error: null,
      createdAt: now,
      updatedAt: now
    }
    repository.insertTask(fixtureTask)
    const vault = new MemoryVault({ 'qwen-api-key': 'fixture-key' })
    const settings = new SettingsService(repository, vault, outputRoot)
    const client = new ParsedResultClient(await createResultZip({
      'result/full.md': '# Safe Title\n',
      'result/middle.json': JSON.stringify({ pdf_info: [] })
    }))
    const service = new TaskService(repository, settings, vault, client, async () => new Response(JSON.stringify({
      choices: [{ message: { content: '安全标题' } }]
    }), { status: 200 }))

    try {
      const processParsedTask = (service as unknown as {
        processParsedTask(taskId: string, resultUrl: string, settings: AppSettings): Promise<void>
      }).processParsedTask.bind(service)
      await processParsedTask(fixtureTask.id, 'https://cdn.example.test/result.zip', await settings.get())

      expect(repository.getTask(fixtureTask.id)).toMatchObject({
        title: 'Safe Title',
        name: 'Safe Title.pdf',
        outputDir: oldOutputDir,
        sourcePath: originalPdf,
        status: 'completed'
      })
      await expect(access(originalPdf)).resolves.toBeUndefined()
      await expect(readFile(join(targetOutputDir, 'sentinel.txt'), 'utf8')).resolves.toBe('keep this directory')
    } finally {
      repository.close()
    }
  })
})

class MemoryVault implements CredentialVault {
  constructor(private readonly values: Partial<Record<CredentialAccount, string>>) {}

  async get(account: CredentialAccount): Promise<string | null> {
    return this.values[account] ?? null
  }

  async set(account: CredentialAccount, value: string): Promise<void> {
    this.values[account] = value
  }

  async delete(account: CredentialAccount): Promise<void> {
    delete this.values[account]
  }

  async has(account: CredentialAccount): Promise<boolean> {
    return Boolean(this.values[account])
  }
}

class PartiallyFailingClient implements MinerUClient {
  uploadedDataIds: string[] = []
  polledDataIds: string[] = []
  private failedDataId = ''

  async verifyToken(): Promise<HealthResult> {
    return { ok: true, message: 'ok' }
  }

  async createUploadBatch(tasks: MinerUTask[], _settings: AppSettings): Promise<BatchSubmission> {
    this.failedDataId = tasks[0]!.id
    return {
      batchId: 'batch-fixture',
      uploads: tasks.map((task) => ({
        taskId: task.id,
        dataId: task.id,
        uploadUrl: `https://upload.example/${task.id}`
      }))
    }
  }

  async uploadFile(_filePath: string, uploadUrl: string): Promise<void> {
    const dataId = uploadUrl.split('/').at(-1)!
    this.uploadedDataIds.push(dataId)
    if (dataId === this.failedDataId) throw new Error('fixture upload failed')
  }

  async getBatchResult(): Promise<BatchResult> {
    throw new Error('not used')
  }

  async waitForBatch(
    _batchId: string,
    _token: string,
    expectedDataIds: Set<string>,
    onUpdate: (result: BatchResult) => void
  ): Promise<BatchResult> {
    this.polledDataIds = [...expectedDataIds]
    const result: BatchResult = {
      batchId: 'batch-fixture',
      entries: [...expectedDataIds].map((dataId) => ({
        dataId,
        fileName: 'second.pdf',
        state: 'failed',
        fullZipUrl: null,
        error: 'fixture parse failed',
        progress: null
      }))
    }
    onUpdate(result)
    return result
  }

  async downloadResult(): Promise<Uint8Array> {
    throw new Error('not used')
  }
}

class ParsedResultClient implements MinerUClient {
  constructor(private readonly result: Uint8Array) {}

  async verifyToken(): Promise<HealthResult> {
    return { ok: true, message: 'ok' }
  }

  async createUploadBatch(): Promise<BatchSubmission> {
    throw new Error('not used')
  }

  async uploadFile(): Promise<void> {
    throw new Error('not used')
  }

  async getBatchResult(): Promise<BatchResult> {
    throw new Error('not used')
  }

  async waitForBatch(): Promise<BatchResult> {
    throw new Error('not used')
  }

  async downloadResult(): Promise<Uint8Array> {
    return this.result
  }
}

async function createResultZip(files: Record<string, string>): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } })
    const output = new PassThrough()
    const chunks: Buffer[] = []
    output.on('data', (chunk: Buffer) => chunks.push(chunk))
    output.on('end', () => resolve(Buffer.concat(chunks)))
    output.on('error', reject)
    archive.on('error', reject)
    archive.pipe(output)
    for (const [name, content] of Object.entries(files)) archive.append(content, { name })
    void archive.finalize()
  })
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Timed out waiting for TaskService queue')
}
