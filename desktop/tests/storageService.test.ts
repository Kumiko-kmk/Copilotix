import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectStorage } from '../src/main/storageService'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('storage inspection', () => {
  it('reports actual document directories, files, and bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilotix-storage-'))
    roots.push(root)
    await mkdir(join(root, 'documents-v2', 'document-a', 'images'), { recursive: true })
    await mkdir(join(root, 'documents-v2', 'document-b'), { recursive: true })
    await writeFile(join(root, 'documents-v2', 'document-a', 'paper.md'), 'hello', 'utf8')
    await writeFile(join(root, 'documents-v2', 'document-a', 'images', 'figure.bin'), Buffer.alloc(7))

    await expect(inspectStorage(root)).resolves.toEqual({
      rootPath: root,
      exists: true,
      documentCount: 2,
      fileCount: 2,
      totalBytes: 12
    })
  })

  it('returns an empty state before the managed documents directory exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilotix-storage-empty-'))
    roots.push(root)
    await expect(inspectStorage(root)).resolves.toEqual({
      rootPath: root,
      exists: false,
      documentCount: 0,
      fileCount: 0,
      totalBytes: 0
    })
  })
})
