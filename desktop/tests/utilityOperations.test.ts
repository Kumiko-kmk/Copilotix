import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createUtilityOperationHandlers } from '../src/utility/core/utilityOperations'

describe('utility persistence lifecycle', () => {
  it('serializes a flush before close', async () => {
    const calls: string[] = []
    const state = {
      database: {
        connection: { exec: (sql: string) => { calls.push(sql) } },
        close: () => { calls.push('close') }
      }
    } as never
    const persistence = createUtilityOperationHandlers(state)
    const signal = new AbortController().signal
    const flush = persistence.handlers['database:flush']!({} as never, signal)
    const close = persistence.close()

    await Promise.all([flush, close])
    expect(calls).toEqual(['PRAGMA wal_checkpoint(PASSIVE)', 'close'])
  })

  it('imports a PDF with one utility-side read and leaves no partial file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mineru-import-'))
    try {
      const sourcePath = join(root, 'paper.pdf')
      const bytes = Buffer.from('%PDF-1.4\nfixture')
      await writeFile(sourcePath, bytes)
      const outputRoot = join(root, 'output')
      const documentId = '11111111-1111-4111-8111-111111111111'
      const persistence = createUtilityOperationHandlers({ outputRoot })
      const result = await persistence.handlers['compute:import-pdf']!({
        payload: { sourcePath, documentId }
      } as never, new AbortController().signal)
      const expectedHash = createHash('sha256').update(bytes).digest('hex')
      const documentRoot = join(outputRoot, 'documents-v2', documentId)

      expect(result).toEqual({ sha256: expectedHash, size: bytes.length })
      await expect(readFile(join(documentRoot, 'original.pdf'))).resolves.toEqual(bytes)
      await expect(readdir(documentRoot)).resolves.toEqual(['original.pdf'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('publishes normalized artifacts only after validation and is idempotent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mineru-normalize-'))
    try {
      const outputDir = join(root, 'document')
      const extractedDir = join(outputDir, '.parsed.partial-job-1')
      await mkdir(extractedDir, { recursive: true })
      const committed = new Set<string>()
      const revisions: Array<{ kind: string; path: string; checksum: string }> = []
      const persistence = createUtilityOperationHandlers({
        repository: {
          recordArtifactRevisions: (items: ReadonlyArray<{ kind: string; path: string; checksum: string; jobId?: string }>) => {
            for (const item of items) {
              const key = `${item.jobId}:${item.kind}:${item.checksum}`
              if (committed.has(key)) continue
              committed.add(key)
              revisions.push(item)
            }
          }
        }
      } as never)
      const task = { id: 'document-1', outputDir }
      const normalize = persistence.handlers['compute:normalize-parser']!
      const signal = new AbortController().signal

      await writeFile(join(extractedDir, 'full.md'), '# parsed\n', 'utf8')
      await expect(normalize({ payload: { task, extractedDir, jobId: 'job-1' } } as never, signal)).rejects.toThrow('incomplete')
      expect(revisions).toHaveLength(0)
      await expect(readFile(join(outputDir, 'full.md'))).rejects.toMatchObject({ code: 'ENOENT' })

      await writeFile(join(extractedDir, 'layout.json'), JSON.stringify({ pdf_info: [] }), 'utf8')
      await normalize({ payload: { task, extractedDir, jobId: 'job-1' } } as never, signal)
      await normalize({ payload: { task, extractedDir, jobId: 'job-1' } } as never, signal)
      expect(revisions).toHaveLength(3)
      await expect(readFile(join(outputDir, 'full.md'), 'utf8')).resolves.toBe('# parsed\n')
      await expect(readdir(outputDir).then((entries) => entries.sort())).resolves.toEqual(['.parsed.partial-job-1', 'block_list.json', 'full.md', 'layout.json'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
