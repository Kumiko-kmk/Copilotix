import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MinerUTask } from '@shared/types'
import { DEFAULT_SETTINGS } from '../src/shared/constants'
import { V2Database } from '../src/utility/core/persistence/v2Database'
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

  it('clears and rebuilds the translation manager when outputRoot changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mineru-manager-lifecycle-'))
    try {
      const outputRoot = join(root, 'output-a')
      const nextOutputRoot = join(root, 'output-b')
      const databasePath = join(root, 'state', 'mineru.sqlite3')
      const taskId = '11111111-1111-4111-8111-111111111111'
      const documentRoot = join(outputRoot, 'documents-v2', taskId)
      await mkdir(documentRoot, { recursive: true })
      await writeFile(join(documentRoot, 'full.md'), '# lifecycle\n', 'utf8')
      await writeFile(join(documentRoot, 'block_list.json'), JSON.stringify({ version: 2, mappings: [] }), 'utf8')

      const state = {} as {
        database?: V2Database
        outputRoot?: string
        translationPlanManager?: unknown
      }
      const persistence = createUtilityOperationHandlers(state as never)
      const signal = new AbortController().signal
      await persistence.handlers['database:init']!({ payload: { databasePath, outputRoot } } as never, signal)
      const task: MinerUTask = {
        id: taskId,
        originalName: 'lifecycle.pdf',
        title: null,
        name: 'lifecycle.pdf',
        sourcePath: join(documentRoot, 'original.pdf'),
        sourceHash: 'fixture-source-hash',
        outputDir: documentRoot,
        status: 'uploading',
        progress: 0,
        parserModel: 'vlm',
        translationProvider: 'qwen',
        remoteBatchId: null,
        remoteDataId: null,
        remoteResultUrl: null,
        error: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
      await persistence.handlers['tasks:insert']!({ payload: { task } } as never, signal)
      await persistence.handlers['tasks:update']!({ payload: { id: taskId, patch: { status: 'translating' } } } as never, signal)
      const job = state.database!.connection.prepare(
        "SELECT id FROM jobs WHERE document_id=? AND kind='translate'"
      ).get(taskId) as { id: string }
      const originalManager = state.translationPlanManager
      await persistence.handlers['compute:translation-plan-open']!({ payload: { taskId, jobId: job.id } } as never, signal)
      expect(state.translationPlanManager).toBe(originalManager)

      await persistence.handlers['settings:save']!({
        payload: { settings: { ...DEFAULT_SETTINGS, outputRoot: nextOutputRoot } }
      } as never, signal)
      expect(state.outputRoot).toBe(nextOutputRoot)
      expect(state.translationPlanManager).toBeUndefined()
      await expect(persistence.handlers['compute:translation-plan-open']!({ payload: { taskId, jobId: job.id } } as never, signal))
        .rejects.toThrow()
      expect(state.translationPlanManager).not.toBe(originalManager)
      await persistence.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
