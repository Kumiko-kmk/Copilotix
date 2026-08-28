import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TaskRepository } from '@main/database'
import type { CredentialAccount, CredentialVault } from '@main/credentialVault'
import type { BatchResult, BatchSubmission, MinerUClient } from '@main/parserClient'
import { SettingsService } from '@main/settingsService'
import { TaskService } from '@main/taskService'
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
