import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
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
    const now = new Date('2026-09-23T12:00:00')
    const root = await mkdtemp(join(tmpdir(), 'copilotix-storage-'))
    roots.push(root)
    await mkdir(join(root, 'documents-v2', 'document-a', 'images'), { recursive: true })
    await mkdir(join(root, 'documents-v2', 'document-b'), { recursive: true })
    const files = [
      ['document-a/original.pdf', 5, '2020-01-01T12:00:00'],
      ['document-a/images/figure.png', 7, '2026-09-20T12:00:00'],
      ['document-a/full.zh-CN.md', 11, '2026-09-22T12:00:00'],
      ['document-b/notes.txt', 3, '2026-09-23T12:00:00']
    ] as const
    for (const [relativePath, bytes, modifiedAt] of files) {
      const path = join(root, 'documents-v2', ...relativePath.split('/'))
      await writeFile(path, Buffer.alloc(bytes))
      await utimes(path, new Date(modifiedAt), new Date(modifiedAt))
    }

    const result = await inspectStorage(root, now)
    expect(result).toMatchObject({
      rootPath: root,
      exists: true,
      documentCount: 2,
      fileCount: 4,
      totalBytes: 26,
      categories: [
        { kind: 'source', fileCount: 1, bytes: 5 },
        { kind: 'image', fileCount: 1, bytes: 7 },
        { kind: 'translation', fileCount: 1, bytes: 11 },
        { kind: 'other', fileCount: 1, bytes: 3 }
      ]
    })
    expect(result.growth).toHaveLength(14)
    expect(result.growth[0]).toEqual({ date: '2026-09-10', totalBytes: 5 })
    expect(result.growth[10]).toEqual({ date: '2026-09-20', totalBytes: 12 })
    expect(result.growth.at(-1)).toEqual({ date: '2026-09-23', totalBytes: 26 })
  })

  it('returns an empty state before the managed documents directory exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilotix-storage-empty-'))
    roots.push(root)
    const result = await inspectStorage(root, new Date('2026-09-23T12:00:00'))
    expect(result).toMatchObject({
      rootPath: root,
      exists: false,
      documentCount: 0,
      fileCount: 0,
      totalBytes: 0,
      categories: [
        { kind: 'source', fileCount: 0, bytes: 0 },
        { kind: 'image', fileCount: 0, bytes: 0 },
        { kind: 'translation', fileCount: 0, bytes: 0 },
        { kind: 'other', fileCount: 0, bytes: 0 }
      ]
    })
    expect(result.growth).toHaveLength(14)
    expect(result.growth.every((point) => point.totalBytes === 0)).toBe(true)
  })
})
