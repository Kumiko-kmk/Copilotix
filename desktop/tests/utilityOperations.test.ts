import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BLOCK_MAPPING_VERSION } from '@core/blockMapping'
import type { CopilotixTask } from '@shared/types'
import { DEFAULT_SETTINGS } from '../src/shared/constants'
import { V2Database } from '../src/utility/core/persistence/v2Database'
import { SqliteRagRepository } from '../src/utility/core/persistence/sqliteRagRepository'
import { V2TaskRepositoryCompat } from '../src/utility/core/persistence/v2TaskRepositoryCompat'
import { byteBoundedPage, createUtilityOperationHandlers } from '../src/utility/core/utilityOperations'

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

  it('keeps quick data operations available while long compute runs, but not across lifecycle operations', async () => {
    const calls: string[] = []
    let finishCompute!: () => void
    const state = {
      database: { connection: { exec: () => { calls.push('flush') } }, close: () => undefined },
      repository: { getTask: () => { calls.push('get'); return null } },
      translationPlanManager: {
        open: () => new Promise<void>((resolve) => {
          calls.push('compute:start')
          finishCompute = () => { calls.push('compute:end'); resolve() }
        })
      }
    } as never
    const persistence = createUtilityOperationHandlers(state)
    const signal = new AbortController().signal
    const ids = { taskId: '11111111-1111-4111-8111-111111111111', jobId: '22222222-2222-4222-8222-222222222222' }

    const compute = persistence.handlers['compute:translation-plan-open']!({ payload: ids } as never, signal)
    await persistence.handlers['tasks:get']!({ payload: { id: ids.taskId } } as never, signal)
    expect(calls).toEqual(['compute:start', 'get'])

    const flush = persistence.handlers['database:flush']!({} as never, signal)
    const afterFlush = persistence.handlers['tasks:get']!({ payload: { id: ids.taskId } } as never, signal)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(calls).toEqual(['compute:start', 'get'])
    finishCompute()
    await Promise.all([compute, flush, afterFlush])
    expect(calls).toEqual(['compute:start', 'get', 'compute:end', 'flush', 'get'])
  })

  it('pages library listings by byte budget with a keyset cursor', () => {
    const rows = Array.from({ length: 5 }, (_, index) => ({
      id: `doc-${index}`,
      createdAt: `2026-01-0${5 - index}T00:00:00.000Z`,
      padding: 'x'.repeat(100)
    }))
    const read = (after: { createdAt: string; id: string } | null, limit: number) => {
      const start = after ? rows.findIndex((row) => row.id === after.id) + 1 : 0
      return rows.slice(start, start + limit)
    }
    const rowBytes = Buffer.byteLength(JSON.stringify(rows[0]), 'utf8')
    const pages: string[][] = []
    let after: { createdAt: string; id: string } | null = null
    do {
      const page = byteBoundedPage(read, after, rowBytes * 2)
      pages.push(page.items.map((row) => row.id))
      after = page.next
    } while (after)
    expect(pages).toEqual([['doc-0', 'doc-1'], ['doc-2', 'doc-3'], ['doc-4']])
    // A row larger than the budget is still returned on its own page.
    expect(byteBoundedPage(read, null, 1).items).toHaveLength(1)
  })

  it('accepts PDFs within the 600-page limit and leaves no partial file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilotix-import-'))
    try {
      const sourcePath = join(root, 'paper.pdf')
      const bytes = createPdf(97)
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
    const root = await mkdtemp(join(tmpdir(), 'copilotix-normalize-'))
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

      await writeFile(join(extractedDir, 'layout.json'), JSON.stringify({
        _backend: 'hybrid',
        pdf_info: [{
          page_idx: 0,
          page_size: [612, 792],
          para_blocks: [{
            type: 'text',
            bbox: [10, 20, 400, 80],
            lines: [{ bbox: [10, 20, 400, 80], spans: [{ content: 'Nested parser text' }] }]
          }]
        }]
      }), 'utf8')
      await normalize({ payload: { task, extractedDir, jobId: 'job-1' } } as never, signal)
      await normalize({ payload: { task, extractedDir, jobId: 'job-1' } } as never, signal)
      expect(revisions).toHaveLength(3)
      await expect(readFile(join(outputDir, 'full.md'), 'utf8')).resolves.toBe('# parsed\n')
      await expect(readFile(join(outputDir, 'block_list.json'), 'utf8').then(JSON.parse)).resolves.toMatchObject({
        version: BLOCK_MAPPING_VERSION,
        mappings: [{ sourceText: 'Nested parser text' }]
      })
      await expect(readdir(outputDir).then((entries) => entries.sort())).resolves.toEqual(['.parsed.partial-job-1', 'block_list.json', 'full.md', 'layout.json'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('atomically upgrades a legacy mapping projection and preserves it when rebuild input is invalid', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilotix-rebuild-mapping-'))
    try {
      const outputDir = join(root, 'document')
      const taskId = '11111111-1111-4111-8111-111111111111'
      const revisions: Array<{ kind: string; path: string; checksum: string }> = []
      await mkdir(outputDir, { recursive: true })
      await writeFile(join(outputDir, 'layout.json'), JSON.stringify({
        _backend: 'pipeline',
        pdf_info: [{
          page_idx: 0,
          page_size: [612, 792],
          para_blocks: [{
            type: 'text',
            bbox: [10, 10, 200, 40],
            lines: [{ bbox: [10, 10, 200, 40], spans: [{ content: 'Repair me' }] }]
          }]
        }]
      }), 'utf8')
      await writeFile(join(outputDir, 'block_list.json'), '{"version":2,"mappings":[]}', 'utf8')
      const persistence = createUtilityOperationHandlers({
        repository: {
          getTask: (id: string) => id === taskId ? { id } : null,
          recordArtifactRevision: (_id: string, kind: string, path: string, checksum: string) => {
            revisions.push({ kind, path, checksum })
          }
        }
      } as never)

      await persistence.handlers['compute:rebuild-mappings']!({ payload: { taskId, outputDir } } as never, new AbortController().signal)
      const repaired = await readFile(join(outputDir, 'block_list.json'), 'utf8')
      expect(JSON.parse(repaired)).toMatchObject({
        version: BLOCK_MAPPING_VERSION,
        mappings: [{ sourceText: 'Repair me' }]
      })
      expect(revisions).toEqual([expect.objectContaining({
        kind: 'block_mappings',
        path: join(outputDir, 'block_list.json'),
        checksum: createHash('sha256').update(repaired).digest('hex')
      })])
      expect((await readdir(outputDir)).some((entry) => entry.startsWith('.block_list.partial-'))).toBe(false)

      await writeFile(join(outputDir, 'layout.json'), '{invalid', 'utf8')
      await expect(persistence.handlers['compute:rebuild-mappings']!(
        { payload: { taskId, outputDir } } as never,
        new AbortController().signal
      )).rejects.toThrow()
      await expect(readFile(join(outputDir, 'block_list.json'), 'utf8')).resolves.toBe(repaired)
      expect((await readdir(outputDir)).some((entry) => entry.startsWith('.block_list.partial-'))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('clears and rebuilds the translation manager when outputRoot changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilotix-manager-lifecycle-'))
    try {
      const outputRoot = join(root, 'output-a')
      const nextOutputRoot = join(root, 'output-b')
      const databasePath = join(root, 'state', 'copilotix.sqlite3')
      const taskId = '11111111-1111-4111-8111-111111111111'
      const documentRoot = join(outputRoot, 'documents-v2', taskId)
      await mkdir(documentRoot, { recursive: true })
      await writeFile(join(documentRoot, 'full.md'), '# lifecycle\n', 'utf8')
      await writeFile(join(documentRoot, 'block_list.json'), JSON.stringify({ version: BLOCK_MAPPING_VERSION, mappings: [] }), 'utf8')

      const state = {} as {
        database?: V2Database
        outputRoot?: string
        translationPlanManager?: unknown
      }
      const persistence = createUtilityOperationHandlers(state as never)
      const signal = new AbortController().signal
      await persistence.handlers['database:init']!({ payload: { databasePath, outputRoot } } as never, signal)
      const task: CopilotixTask = {
        id: taskId,
        originalName: 'lifecycle.pdf',
        title: null,
        name: 'lifecycle.pdf',
        sourcePath: join(documentRoot, 'original.pdf'),
        sourceHash: 'fixture-source-hash',
        outputDir: documentRoot,
        status: 'uploading',
        progress: 0,
        translationProvider: 'qwen',
        remoteBatchId: null,
        remoteDataId: null,
        remoteResultUrl: null,
        error: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
      await persistence.handlers['tasks:insert-many']!({ payload: { tasks: [task] } } as never, signal)
      new V2TaskRepositoryCompat(state.database!).updateTask(taskId, { status: 'translating' })
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

  it('routes knowledge consent and embedding precondition errors through Utility handlers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilotix-knowledge-operations-'))
    try {
      const outputRoot = join(root, 'output')
      const outputDir = join(outputRoot, 'documents-v2', '11111111-1111-4111-8111-111111111111')
      await mkdir(outputDir, { recursive: true })
      const state = {} as { database?: V2Database; databasePath?: string; outputRoot?: string }
      const persistence = createUtilityOperationHandlers(state as never)
      const signal = new AbortController().signal
      await persistence.handlers['database:init']!({
        payload: { databasePath: join(root, 'state', 'copilotix.sqlite3'), outputRoot }
      } as never, signal)
      const task: CopilotixTask = {
        id: '11111111-1111-4111-8111-111111111111',
        originalName: 'knowledge.pdf',
        title: null,
        name: 'knowledge.pdf',
        sourcePath: join(outputDir, 'original.pdf'),
        sourceHash: 'knowledge-source-hash',
        outputDir,
        status: 'uploading',
        progress: 0,
        translationProvider: 'qwen',
        remoteBatchId: null,
        remoteDataId: null,
        remoteResultUrl: null,
        error: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
      await persistence.handlers['tasks:insert-many']!({ payload: { tasks: [task] } } as never, signal)
      await expect(persistence.handlers['knowledge:get']!({ payload: { documentId: task.id } } as never, signal)).resolves.toMatchObject({
        documentId: task.id,
        localState: 'unindexed',
        semanticConsent: false
      })
      await expect(persistence.handlers['knowledge:set-semantic-consent']!({
        payload: { documentId: task.id, consent: true }
      } as never, signal)).resolves.toMatchObject({ semanticConsent: true, semanticState: 'requires-credential' })
      await expect(persistence.handlers['knowledge:ensure-embed']!({
        payload: { documentId: task.id, profileId: 'embedding-default' }
      } as never, signal)).rejects.toThrow(expect.objectContaining({ code: 'RAG_CONTENT_NOT_READY' }))
      await persistence.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('preserves non-retryable RAG content errors through the Utility handler', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilotix-rag-error-'))
    try {
      const outputRoot = join(root, 'output')
      const documentId = '11111111-1111-4111-8111-111111111111'
      const documentRoot = join(outputRoot, 'documents-v2', documentId)
      await mkdir(join(documentRoot, 'artifacts'), { recursive: true })
      const markdown = '# Mapping\n\nbody'
      const mappingJson = '{invalid-json'
      await writeFile(join(documentRoot, 'artifacts', 'paper.md'), markdown, 'utf8')
      await writeFile(join(documentRoot, 'artifacts', 'bad-mappings.json'), mappingJson, 'utf8')
      const state = {} as { database?: V2Database; databasePath?: string; outputRoot?: string }
      const persistence = createUtilityOperationHandlers(state as never)
      const signal = new AbortController().signal
      await persistence.handlers['database:init']!({
        payload: { databasePath: join(root, 'state', 'copilotix.sqlite3'), outputRoot }
      } as never, signal)
      const now = '2026-01-01T00:00:00.000Z'
      const hash = (value: string) => createHash('sha256').update(value).digest('hex')
      state.database!.connection.prepare(`INSERT INTO documents(id,original_filename,display_title,storage_path,source_checksum,translation_provider,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`).run(
        documentId, 'paper.pdf', null, documentRoot, 'source', 'qwen', now, now
      )
      state.database!.connection.prepare(`INSERT INTO artifacts(id,document_id,kind,revision,relative_path,content_hash,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)`).run(
        'parsed', documentId, 'parsed_markdown', 1, 'artifacts/paper.md', hash(markdown), '{}', now
      )
      state.database!.connection.prepare(`INSERT INTO artifacts(id,document_id,kind,revision,relative_path,content_hash,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)`).run(
        'bad-mappings', documentId, 'block_mappings', 1, 'artifacts/bad-mappings.json', hash(mappingJson), '{}', now
      )
      const revision = new SqliteRagRepository(state.database!).createContentRevision({
        documentId, artifactId: 'parsed', contentHash: hash(markdown), mappingFingerprint: hash(mappingJson),
        chunkerFingerprint: 'chunker', contentRevisionId: 'rag-error-revision', now
      })
      await expect(persistence.handlers['compute:rag-content-index']!({
        payload: { documentId, contentRevisionId: revision.contentRevisionId }
      } as never, signal)).rejects.toMatchObject({ code: 'RAG_BLOCK_MAPPING_INVALID_JSON', retryable: false })
      await persistence.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function createPdf(pageCount: number): Buffer {
  const pageObjectNumbers = Array.from({ length: pageCount }, (_, index) => index + 3)
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${pageCount} /Kids [${pageObjectNumbers.map((number) => `${number} 0 R`).join(' ')}] >>`,
    ...pageObjectNumbers.map(() => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> >>')
  ]
  let body = '%PDF-1.7\n'
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, 'ascii'))
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xrefOffset = Buffer.byteLength(body, 'ascii')
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(body, 'ascii')
}
