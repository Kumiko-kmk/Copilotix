import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Timed out waiting for TaskService queue')
}
