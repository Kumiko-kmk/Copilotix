import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CompatDocumentRow, CompatJobRow } from '../src/utility/core/persistence/v2TaskRepositoryCompat'
import { projectCompatTask, V2TaskRepositoryCompat } from '../src/utility/core/persistence/v2TaskRepositoryCompat'
import { V2Database } from '../src/utility/core/persistence/v2Database'
import type { MinerUTask, ReaderAnnotation } from '@shared/types'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function createFixture(): Promise<{ root: string; database: V2Database; repository: V2TaskRepositoryCompat; task: MinerUTask }> {
  const root = await mkdtemp(join(tmpdir(), 'mineru-v2-compat-'))
  roots.push(root)
  const database = new V2Database(join(root, 'mineru-desktop-v2.sqlite3'))
  const repository = new V2TaskRepositoryCompat(database)
  const outputDir = join(root, 'documents-v2', 'document-1')
  await mkdir(outputDir, { recursive: true })
  const now = '2026-01-01T00:00:00.000Z'
  const task: MinerUTask = {
    id: 'document-1',
    originalName: 'paper.pdf',
    title: null,
    name: 'paper.pdf',
    sourcePath: join(outputDir, 'original.pdf'),
    sourceHash: 'source-hash',
    outputDir,
    status: 'uploading',
    progress: 0,
    parserModel: 'vlm',
    translationProvider: 'qwen',
    remoteBatchId: null,
    remoteDataId: null,
    remoteResultUrl: null,
    error: null,
    createdAt: now,
    updatedAt: now
  }
  repository.insertTask(task)
  return { root, database, repository, task }
}

function closeFixture(repository: V2TaskRepositoryCompat): void {
  repository.close()
}

describe('temporary v2 task repository compatibility projection', () => {
  it('inserts one document, queued parse job and source artifact without a tasks table', async () => {
    const fixture = await createFixture()
    try {
      expect(fixture.repository.getTask(fixture.task.id)).toMatchObject({
        id: fixture.task.id,
        outputDir: fixture.task.outputDir,
        sourcePath: fixture.task.sourcePath,
        status: 'uploading'
      })
      expect(fixture.database.connection.prepare('SELECT COUNT(*) AS count FROM documents').get()).toEqual({ count: 1 })
      expect(fixture.database.connection.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toEqual({ count: 1 })
      expect(fixture.database.connection.prepare('SELECT COUNT(*) AS count FROM artifacts').get()).toEqual({ count: 1 })
      expect(fixture.database.connection.prepare('SELECT kind,status,max_attempts FROM jobs').get()).toEqual({
        kind: 'parse', status: 'queued', max_attempts: 5
      })
      expect(fixture.database.connection.prepare('SELECT kind,relative_path FROM artifacts').get()).toEqual({
        kind: 'source_pdf', relative_path: 'original.pdf'
      })
      expect(fixture.database.connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").get()).toBeUndefined()
    } finally {
      closeFixture(fixture.repository)
    }
  })

  it('keeps title metadata separate from the stable UUID storage path', async () => {
    const fixture = await createFixture()
    try {
      const outputDir = fixture.task.outputDir
      const sourcePath = fixture.task.sourcePath
      const updated = fixture.repository.updateTask(fixture.task.id, {
        title: 'Attention Is All You Need',
        name: 'Attention Is All You Need.pdf'
      })
      expect(updated).toMatchObject({
        title: 'Attention Is All You Need',
        name: 'Attention Is All You Need.pdf',
        outputDir,
        sourcePath
      })
      expect(fixture.database.connection.prepare('SELECT display_title,storage_path FROM documents WHERE id=?').get(fixture.task.id))
        .toEqual({ display_title: 'Attention Is All You Need', storage_path: outputDir })
    } finally {
      closeFixture(fixture.repository)
    }
  })

  it('projects remote IDs into parse checkpoint and creates a dependent translate job', async () => {
    const fixture = await createFixture()
    try {
      fixture.repository.updateTask(fixture.task.id, {
        status: 'parsing',
        progress: 17,
        remoteBatchId: 'batch-1',
        remoteDataId: 'data-1',
        remoteResultUrl: 'https://example.test/result.zip'
      })
      const parsing = fixture.repository.getTask(fixture.task.id)
      expect(parsing).toMatchObject({
        status: 'parsing', progress: 17,
        remoteBatchId: 'batch-1', remoteDataId: 'data-1', remoteResultUrl: 'https://example.test/result.zip'
      })
      const parseCheckpoint = fixture.database.connection.prepare(
        "SELECT checkpoint_json FROM jobs WHERE document_id=? AND kind='parse'"
      ).get(fixture.task.id) as { checkpoint_json: string }
      expect(JSON.parse(parseCheckpoint.checkpoint_json)).toMatchObject({
        remoteBatchId: 'batch-1', remoteDataId: 'data-1', remoteResultUrl: 'https://example.test/result.zip'
      })
      expect(fixture.database.connection.prepare('PRAGMA table_info(documents)').all()).not.toContainEqual(
        expect.objectContaining({ name: 'remote_batch_id' })
      )

      fixture.repository.updateTask(fixture.task.id, { status: 'translating', progress: 45 })
      const jobs = fixture.database.connection.prepare(
        'SELECT kind,status,depends_on_job_id FROM jobs WHERE document_id=? ORDER BY kind'
      ).all(fixture.task.id) as Array<{ kind: string; status: string; depends_on_job_id: string | null }>
      const parse = jobs.find((job) => job.kind === 'parse')
      const translate = jobs.find((job) => job.kind === 'translate')
      expect(parse).toMatchObject({ status: 'succeeded', depends_on_job_id: null })
      expect(translate).toMatchObject({ status: 'running' })
      const parseId = fixture.database.connection.prepare(
        "SELECT id FROM jobs WHERE document_id=? AND kind='parse'"
      ).get(fixture.task.id) as { id: string }
      expect(translate?.depends_on_job_id).toBe(parseId.id)
      expect(fixture.repository.getTask(fixture.task.id)).toMatchObject({ status: 'translating', progress: 45 })
    } finally {
      closeFixture(fixture.repository)
    }
  })

  it('uses the latest translate job for legacy blocks and keeps artifact completion idempotent', async () => {
    const fixture = await createFixture()
    try {
      fixture.repository.updateTask(fixture.task.id, { status: 'translating', progress: 45 })
      const parsedPath = join(fixture.task.outputDir, 'full.md')
      fixture.repository.recordArtifactRevision(fixture.task.id, 'parsed_markdown', parsedPath, 'parsed-hash')
      fixture.repository.recordArtifactRevision(fixture.task.id, 'parsed_markdown', parsedPath, 'parsed-hash')
      expect(() => fixture.repository.recordArtifactRevision(
        fixture.task.id, 'parsed_markdown', parsedPath, 'different-hash'
      )).toThrow('ARTIFACT_COMMIT_CONFLICT')
      expect(() => fixture.repository.recordArtifactRevision(
        fixture.task.id, 'parsed_markdown', join(fixture.task.outputDir, '..', 'escaped.md'), 'escaped-hash'
      )).toThrow()
      expect(fixture.database.connection.prepare(
        "SELECT COUNT(*) AS count,MAX(revision) AS revision FROM artifacts WHERE document_id=? AND kind='parsed_markdown'"
      ).get(fixture.task.id)).toEqual({ count: 1, revision: 1 })

      fixture.repository.upsertTranslationBlock({
        taskId: fixture.task.id,
        blockId: 'block-1',
        sourceHash: 'block-hash',
        sourceMarkdown: 'A source block',
        translatedMarkdown: '一个源块',
        provider: 'qwen',
        model: 'fixture',
        status: 'completed',
        error: null
      })
      expect(fixture.repository.listTranslationBlocks(fixture.task.id)).toEqual([expect.objectContaining({
        taskId: fixture.task.id, blockId: 'block-1', translatedMarkdown: '一个源块'
      })])

      const translatedPath = join(fixture.task.outputDir, 'full.zh-CN.md')
      fixture.repository.recordArtifactRevision(fixture.task.id, 'translated_markdown', translatedPath, 'translated-hash')
      fixture.repository.recordArtifactRevision(fixture.task.id, 'translated_markdown', translatedPath, 'translated-hash')
      expect(fixture.database.connection.prepare(
        "SELECT COUNT(*) AS count,MAX(revision) AS revision FROM artifacts WHERE document_id=? AND kind='translated_markdown'"
      ).get(fixture.task.id)).toEqual({ count: 1, revision: 1 })
    } finally {
      closeFixture(fixture.repository)
    }
  })

  it('commits a bounded translation batch against its explicit translate job', async () => {
    const fixture = await createFixture()
    try {
      fixture.repository.updateTask(fixture.task.id, { status: 'translating', progress: 45 })
      const job = fixture.database.connection.prepare(
        "SELECT id FROM jobs WHERE document_id=? AND kind='translate'"
      ).get(fixture.task.id) as { id: string }
      fixture.repository.commitTranslationBatch({
        taskId: fixture.task.id,
        jobId: job.id,
        blocks: [{
          blockId: 'batch-block-1',
          sourceHash: 'batch-source-hash',
          sourceMarkdown: 'Batch source',
          translatedMarkdown: '批量译文',
          provider: 'qwen',
          model: 'fixture',
          status: 'completed',
          error: null
        }],
        cacheEntries: [{ cacheKey: 'batch-cache', translated: '批量译文', provider: 'qwen', model: 'fixture' }],
        checkpoint: { totalBlocks: 1, completedBlocks: 1, failedBlocks: 0, failedBlockIds: [] }
      })

      expect(fixture.repository.listTranslationBlocks(fixture.task.id, job.id)).toEqual([
        expect.objectContaining({ taskId: fixture.task.id, jobId: job.id, blockId: 'batch-block-1' })
      ])
      expect(fixture.database.connection.prepare('SELECT translated_markdown FROM translation_cache WHERE cache_key=?').get('batch-cache'))
        .toEqual({ translated_markdown: '批量译文' })
      const checkpoint = fixture.database.connection.prepare('SELECT checkpoint_json FROM jobs WHERE id=?').get(job.id) as { checkpoint_json: string }
      expect(JSON.parse(checkpoint.checkpoint_json)).toMatchObject({ totalBlocks: 1, completedBlocks: 1, failedBlocks: 0 })
      expect(() => fixture.repository.commitTranslationBatch({
        taskId: fixture.task.id,
        jobId: 'not-this-job',
        blocks: [],
        cacheEntries: []
      })).toThrow('翻译作业尚未创建')
    } finally {
      closeFixture(fixture.repository)
    }
  })

  it('rejects source and derived artifact paths that escape the document root', async () => {
    const fixture = await createFixture()
    try {
      const unsafeOutputDir = join(fixture.root, 'documents-v2', 'document-2')
      await mkdir(unsafeOutputDir, { recursive: true })
      expect(() => fixture.repository.insertTask({
        ...fixture.task,
        id: 'document-2',
        outputDir: unsafeOutputDir,
        sourcePath: unsafeOutputDir
      })).toThrow()
      expect(fixture.database.connection.prepare('SELECT id FROM documents WHERE id=?').get('document-2')).toBeUndefined()

      const outside = process.platform === 'win32' ? String.raw`Z:\outside\artifact.md` : '/outside-volume/artifact.md'
      expect(() => fixture.repository.recordArtifactRevision(
        fixture.task.id, 'parsed_markdown', outside, 'outside-hash'
      )).toThrow()
      expect(() => fixture.repository.recordArtifactRevision(
        fixture.task.id, 'parsed_markdown', fixture.task.outputDir, 'root-hash'
      )).toThrow()
      expect(() => fixture.repository.recordArtifactRevision(
        fixture.task.id, 'parsed_markdown', join(fixture.task.outputDir, '..', 'outside.md'), 'parent-hash'
      )).toThrow()
      expect(() => fixture.repository.recordArtifactRevision(
        fixture.task.id, 'parsed_markdown', `${fixture.task.outputDir}${process.platform === 'win32' ? '\\' : '/'}bad\0name`, 'nul-hash'
      )).toThrow(/NUL/)
    } finally {
      closeFixture(fixture.repository)
    }
  })

  it('requires a current view artifact and stores annotation replacements against that artifact set', async () => {
    const fixture = await createFixture()
    try {
      const annotation = makeAnnotation(fixture.task.id, 'original', 'annotation-1')
      expect(() => fixture.repository.replaceReaderAnnotations({
        taskId: fixture.task.id, view: 'original', annotations: [annotation]
      })).toThrow('当前文档尚无可标注的产物')

      fixture.repository.recordArtifactRevision(fixture.task.id, 'parsed_markdown', join(fixture.task.outputDir, 'full.md'), 'parsed-hash')
      expect(fixture.repository.replaceReaderAnnotations({
        taskId: fixture.task.id, view: 'original', annotations: [annotation]
      })).toEqual([expect.objectContaining({ taskId: fixture.task.id, view: 'original' })])
      expect(fixture.repository.listReaderAnnotations(fixture.task.id)).toEqual([expect.objectContaining({
        id: 'annotation-1', taskId: fixture.task.id, view: 'original', quote: 'alpha'
      })])
      const set = fixture.database.connection.prepare(
        "SELECT document_id,artifact_id,view FROM annotation_sets WHERE document_id=?"
      ).get(fixture.task.id) as { document_id: string; artifact_id: string; view: string }
      expect(set).toMatchObject({ document_id: fixture.task.id, view: 'original' })

      const newerTimestamp = new Date(Date.now() + 1_000).toISOString()
      fixture.database.connection.prepare(`
        INSERT INTO jobs(
          id,document_id,depends_on_job_id,kind,status,progress,priority,attempt,max_attempts,payload_json,checkpoint_json,
          available_at,lease_owner,lease_expires_at,error_code,error_message,started_at,finished_at,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run('parse-2', fixture.task.id, null, 'parse', 'succeeded', 100, 0, 1, 5, '{}', '{}', newerTimestamp,
        null, null, null, null, newerTimestamp, newerTimestamp, newerTimestamp, newerTimestamp)
      fixture.repository.recordArtifactRevision(
        fixture.task.id, 'parsed_markdown', join(fixture.task.outputDir, 'full.v2.md'), 'parsed-hash-v2'
      )
      expect(fixture.repository.listReaderAnnotations(fixture.task.id)).toEqual([])
    } finally {
      closeFixture(fixture.repository)
    }
  })

  it('exposes pure document/job projection rules for renderer compatibility', () => {
    const document: CompatDocumentRow = {
      id: 'document-1',
      original_filename: 'paper.pdf',
      display_title: 'Stable title',
      storage_path: 'C:/output/documents-v2/document-1',
      source_checksum: 'hash',
      parser_model: 'vlm',
      translation_provider: 'qwen',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z'
    }
    const parse: CompatJobRow = makeJob({
      id: 'parse-1', kind: 'parse', status: 'succeeded', progress: 42,
      checkpoint_json: JSON.stringify({ phase: 'parsing', remoteBatchId: 'batch-1', remoteDataId: 'data-1' }),
      updated_at: '2026-01-01T00:00:01.000Z'
    })
    const translate: CompatJobRow = makeJob({
      id: 'translate-1', kind: 'translate', status: 'partial', progress: 100,
      depends_on_job_id: 'parse-1', updated_at: '2026-01-01T00:00:02.000Z'
    })
    expect(projectCompatTask(document, [translate, parse])).toMatchObject({
      title: 'Stable title', name: 'Stable title.pdf', outputDir: document.storage_path,
      status: 'partial', progress: 100, remoteBatchId: 'batch-1', remoteDataId: 'data-1'
    })
  })
})

function makeAnnotation(taskId: string, view: 'original' | 'translated', id: string): ReaderAnnotation {
  return {
    id,
    taskId,
    view,
    kind: 'highlight',
    color: 'yellow',
    blockKey: 'content:0',
    startOffset: 0,
    endOffset: 5,
    quote: 'alpha',
    prefix: '',
    suffix: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

function makeJob(overrides: Partial<CompatJobRow>): CompatJobRow {
  return {
    id: 'job',
    document_id: 'document-1',
    depends_on_job_id: null,
    kind: 'parse',
    status: 'queued',
    progress: 0,
    priority: 0,
    attempt: 0,
    max_attempts: 5,
    payload_json: '{}',
    checkpoint_json: '{}',
    available_at: '2026-01-01T00:00:00.000Z',
    lease_owner: null,
    lease_expires_at: null,
    error_code: null,
    error_message: null,
    started_at: null,
    finished_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}
