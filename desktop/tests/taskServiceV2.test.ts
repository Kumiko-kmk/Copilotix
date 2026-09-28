import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { V2Database } from '../src/utility/core/persistence/v2Database'
import type { CredentialVault } from '@main/credentialVault'
import { V2TaskRepositoryCompat } from '../src/utility/core/persistence/v2TaskRepositoryCompat'
import { SettingsService } from '@main/settingsService'
import { TaskService } from '@main/taskService'
import type { ParserClient } from '@main/parserClient'
import type { CopilotixTask } from '@shared/types'
import { fixtureTaskCompute } from './taskComputeFixture'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('TaskService v2 path integration', () => {
  it('resolves only assets below the document root and deletes a document through PathPolicy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilotix-task-service-v2-'))
    roots.push(root)
    const outputRoot = join(root, 'output')
    const documentRoot = join(outputRoot, 'documents-v2')
    const outputDir = join(documentRoot, 'document-1')
    await mkdir(outputDir, { recursive: true })
    const sourcePath = join(outputDir, 'original.pdf')
    await writeFile(sourcePath, '%PDF-1.4 fixture')
    const database = new V2Database(join(root, 'copilotix-desktop-v2.sqlite3'))
    const repository = new V2TaskRepositoryCompat(database)
    const vault = emptyVault()
    try {
      repository.insertTask(task(outputDir, sourcePath))
      const settings = new SettingsService(repository, vault, outputRoot)
      const service = new TaskService(repository, settings, vault, unusedClient(), async () => new Response(), fixtureTaskCompute)

      await expect(service.resolveAsset('document-1', 'original.pdf')).resolves.toBe(await realpath(sourcePath))
      await expect(service.resolveAsset('document-1', '../outside.pdf')).rejects.toThrow()
      await expect(service.resolveAsset('document-1', `${outputDir}\0escape.pdf`)).rejects.toThrow(/NUL/)

      await writeFile(join(outputDir, 'sentinel.txt'), 'delete me')
      await service.delete('document-1', true)
      await expect(access(outputDir)).rejects.toThrow()
      expect(repository.getTask('document-1')).toBeNull()
    } finally {
      repository.close()
    }
  })

  it('refuses to delete a document directory outside outputRoot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilotix-task-service-v2-escape-'))
    roots.push(root)
    const outputRoot = join(root, 'output')
    const outsideDir = join(root, 'outside')
    await mkdir(outsideDir, { recursive: true })
    const sourcePath = join(outsideDir, 'original.pdf')
    await writeFile(sourcePath, '%PDF-1.4 fixture')
    const database = new V2Database(join(root, 'copilotix-desktop-v2.sqlite3'))
    const repository = new V2TaskRepositoryCompat(database)
    const vault = emptyVault()
    try {
      repository.insertTask(task(outsideDir, sourcePath, 'outside-document'))
      const settings = new SettingsService(repository, vault, outputRoot)
      const service = new TaskService(repository, settings, vault, unusedClient(), async () => new Response(), fixtureTaskCompute)

      await expect(service.delete('outside-document', true)).rejects.toThrow()
      await expect(access(outsideDir)).resolves.toBeUndefined()
      expect(repository.getTask('outside-document')).not.toBeNull()
    } finally {
      repository.close()
    }
  })
})

function task(outputDir: string, sourcePath: string, id = 'document-1'): CopilotixTask {
  const now = '2026-01-01T00:00:00.000Z'
  return {
    id,
    originalName: 'paper.pdf',
    title: null,
    name: 'paper.pdf',
    sourcePath,
    sourceHash: `hash-${id}`,
    outputDir,
    status: 'uploading',
    progress: 0,
    translationProvider: 'qwen',
    remoteBatchId: null,
    remoteDataId: null,
    remoteResultUrl: null,
    error: null,
    createdAt: now,
    updatedAt: now
  }
}

function emptyVault(): CredentialVault {
  return {
    get: async () => null,
    set: async () => undefined,
    delete: async () => undefined,
    has: async () => false
  }
}

function unusedClient(): ParserClient {
  return {
    verifyToken: async () => ({ ok: true, message: 'unused' }),
    createUploadBatch: async () => { throw new Error('unused') },
    uploadFile: async () => { throw new Error('unused') },
    getBatchResult: async () => { throw new Error('unused') },
    waitForBatch: async () => { throw new Error('unused') },
    downloadResult: async () => { throw new Error('unused') }
  }
}
