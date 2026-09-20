import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CompatDocumentRow, CompatJobRow } from '../src/utility/core/persistence/v2TaskRepositoryCompat'
import { projectCompatTask, V2TaskRepositoryCompat } from '../src/utility/core/persistence/v2TaskRepositoryCompat'
import { V2Database } from '../src/utility/core/persistence/v2Database'
import type { CopilotixTask, ReaderAnnotation } from '@shared/types'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function createFixture(): Promise<{ root: string; database: V2Database; repository: V2TaskRepositoryCompat; task: CopilotixTask }> {
  const root = await mkdtemp(join(tmpdir(), 'copilotix-v2-compat-'))
  roots.push(root)
  const database = new V2Database(join(root, 'copilotix-desktop-v2.sqlite3'))
  const repository = new V2TaskRepositoryCompat(database)
  const outputDir = join(root, 'documents-v2', 'document-1')
  await mkdir(outputDir, { recursive: true })
  const now = '2026-01-01T00:00:00.000Z'
  const task: CopilotixTask = {
    id: 'document-1',
    originalName: 'paper.pdf',
    title: null,
    name: 'paper.pdf',
    sourcePath: join(outputDir, 'original.pdf'),
    sourceHash: 'source-hash',
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

  it('publishes one canonical content revision/job for duplicate parsed bundles and supersedes obsolete content work', async () => {
    const fixture = await createFixture()
    try {
      const parse = fixture.database.connection.prepare("SELECT id FROM jobs WHERE document_id=? AND kind='parse'").get(fixture.task.id) as { id: string }
      fixture.database.connection.prepare("UPDATE jobs SET status='succeeded',progress=100,finished_at=?,updated_at=? WHERE id=?")
        .run('2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z', parse.id)
      const outputDir = fixture.task.outputDir
      fixture.repository.recordArtifactRevisions([
        { taskId: fixture.task.id, kind: 'parsed_markdown', path: join(outputDir, 'full.md'), checksum: 'content-hash-1', jobId: parse.id },
        {
          taskId: fixture.task.id,
          kind: 'block_mappings',
          path: join(outputDir, 'block_list.json'),
          checksum: 'mapping-hash-1',
          metadata: { mappingFingerprint: 'mapping-fingerprint-1', chunkerFingerprint: 'chunker-v1' },
          jobId: parse.id
        }
      ])

      const firstRevision = fixture.database.connection.prepare('SELECT * FROM rag_content_revisions WHERE document_id=?').get(fixture.task.id) as {
        content_revision_id: string
        artifact_id: string
        content_hash: string
        mapping_fingerprint: string
        chunker_fingerprint: string
        state: string
      }
      expect(firstRevision).toMatchObject({
        content_hash: 'content-hash-1',
        mapping_fingerprint: 'mapping-fingerprint-1',
        chunker_fingerprint: 'chunker-v1',
        state: 'building'
      })
      expect(fixture.database.connection.prepare("SELECT id,status FROM jobs WHERE document_id=? AND kind='rag-content-index'").all(fixture.task.id))
        .toEqual([expect.objectContaining({ id: expect.stringMatching(/^rag-content-job-/u), status: 'queued' })])

      // A retry can use a different parse job and artifact IDs.  The three
      // fingerprints, rather than artifact provenance, remain the identity.
      fixture.database.connection.prepare(`
        INSERT INTO jobs(
          id,document_id,depends_on_job_id,kind,status,progress,priority,attempt,max_attempts,payload_json,checkpoint_json,
          available_at,lease_owner,lease_expires_at,error_code,error_message,started_at,finished_at,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run('parse-retry-1', fixture.task.id, null, 'parse', 'succeeded', 100, 0, 1, 5, '{}', '{}',
        '2026-01-01T00:00:02.000Z', null, null, null, null, '2026-01-01T00:00:02.000Z', '2026-01-01T00:00:02.000Z',
        '2026-01-01T00:00:02.000Z', '2026-01-01T00:00:02.000Z')
      fixture.repository.recordArtifactRevisions([
        { taskId: fixture.task.id, kind: 'parsed_markdown', path: join(outputDir, 'retry.md'), checksum: 'content-hash-1', jobId: 'parse-retry-1' },
        {
          taskId: fixture.task.id,
          kind: 'block_mappings',
          path: join(outputDir, 'retry-blocks.json'),
          checksum: 'mapping-hash-1-retry',
          metadata: { mappingFingerprint: 'mapping-fingerprint-1', chunkerFingerprint: 'chunker-v1' },
          jobId: 'parse-retry-1'
        }
      ])
      expect(fixture.database.connection.prepare('SELECT COUNT(*) AS count FROM rag_content_revisions WHERE document_id=?').get(fixture.task.id))
        .toEqual({ count: 1 })
      expect(fixture.database.connection.prepare("SELECT COUNT(*) AS count FROM jobs WHERE document_id=? AND kind='rag-content-index'").get(fixture.task.id))
        .toEqual({ count: 1 })
      expect(fixture.database.connection.prepare('SELECT artifact_id FROM rag_content_revisions WHERE document_id=?').get(fixture.task.id))
        .toEqual({ artifact_id: firstRevision.artifact_id })

      // A deterministic row may already exist in a terminal state after a
      // failed runner attempt. Republishing the same complete bundle must
      // recover that row in place; otherwise local_state could be queued with
      // no executable content job behind it.
      const firstContentJob = fixture.database.connection.prepare(
        "SELECT id FROM jobs WHERE document_id=? AND kind='rag-content-index'"
      ).get(fixture.task.id) as { id: string }
      fixture.database.connection.prepare(
        "UPDATE jobs SET status='failed',error_code='RAG_CONTENT_FAILED',error_message='fixture',finished_at=?,updated_at=? WHERE id=?"
      ).run('2026-01-01T00:00:02.500Z', '2026-01-01T00:00:02.500Z', firstContentJob.id)
      // Leave an unrelated active row behind to prove supersession happens
      // before the terminal deterministic target is requeued.
      fixture.database.connection.prepare(`
        INSERT INTO jobs(
          id,document_id,depends_on_job_id,kind,status,progress,priority,attempt,max_attempts,payload_json,checkpoint_json,
          available_at,lease_owner,lease_expires_at,error_code,error_message,started_at,finished_at,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run('obsolete-content-job', fixture.task.id, null, 'rag-content-index', 'queued', 0, -100, 0, 5, '{}', '{}',
        '2026-01-01T00:00:02.500Z', null, null, null, null, null, null,
        '2026-01-01T00:00:02.500Z', '2026-01-01T00:00:02.500Z')
      fixture.repository.recordArtifactRevisions([
        { taskId: fixture.task.id, kind: 'parsed_markdown', path: join(outputDir, 'full.md'), checksum: 'content-hash-1', jobId: parse.id },
        {
          taskId: fixture.task.id,
          kind: 'block_mappings',
          path: join(outputDir, 'block_list.json'),
          checksum: 'mapping-hash-1',
          metadata: { mappingFingerprint: 'mapping-fingerprint-1', chunkerFingerprint: 'chunker-v1' },
          jobId: parse.id
        }
      ])
      expect(fixture.database.connection.prepare('SELECT status,attempt FROM jobs WHERE id=?').get(firstContentJob.id))
        .toEqual({ status: 'queued', attempt: 1 })
      expect(fixture.database.connection.prepare('SELECT status,error_code FROM jobs WHERE id=?').get('obsolete-content-job'))
        .toEqual({ status: 'cancelled', error_code: 'RAG_CONTENT_SUPERSEDED' })

      // A new immutable hash gets a new revision; the old queued work becomes
      // terminal before the replacement job is inserted.
      fixture.database.connection.prepare(`
        INSERT INTO jobs(
          id,document_id,depends_on_job_id,kind,status,progress,priority,attempt,max_attempts,payload_json,checkpoint_json,
          available_at,lease_owner,lease_expires_at,error_code,error_message,started_at,finished_at,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run('parse-retry-2', fixture.task.id, null, 'parse', 'succeeded', 100, 0, 1, 5, '{}', '{}',
        '2026-01-01T00:00:03.000Z', null, null, null, null, '2026-01-01T00:00:03.000Z', '2026-01-01T00:00:03.000Z',
        '2026-01-01T00:00:03.000Z', '2026-01-01T00:00:03.000Z')
      fixture.repository.recordArtifactRevisions([
        { taskId: fixture.task.id, kind: 'parsed_markdown', path: join(outputDir, 'new.md'), checksum: 'content-hash-2', jobId: 'parse-retry-2' },
        {
          taskId: fixture.task.id,
          kind: 'block_mappings',
          path: join(outputDir, 'new-blocks.json'),
          checksum: 'mapping-hash-2',
          metadata: { mappingFingerprint: 'mapping-fingerprint-2', chunkerFingerprint: 'chunker-v1' },
          jobId: 'parse-retry-2'
        }
      ])
      expect(fixture.database.connection.prepare('SELECT COUNT(*) AS count FROM rag_content_revisions WHERE document_id=?').get(fixture.task.id))
        .toEqual({ count: 2 })
      expect(fixture.database.connection.prepare(
        'SELECT state FROM rag_content_revisions WHERE document_id=? AND content_hash=?'
      ).get(fixture.task.id, 'content-hash-1')).toEqual({ state: 'stale' })
      const contentJobs = fixture.database.connection.prepare(
        "SELECT status,error_code FROM jobs WHERE document_id=? AND kind='rag-content-index' ORDER BY id"
      ).all(fixture.task.id) as Array<{ status: string; error_code: string | null }>
      expect(contentJobs).toHaveLength(3)
      expect(contentJobs.filter((job) => job.status === 'queued')).toHaveLength(1)
      expect(contentJobs.filter((job) => job.status === 'cancelled')).toHaveLength(2)
      expect(contentJobs.filter((job) => job.status === 'cancelled').every((job) => job.error_code === 'RAG_CONTENT_SUPERSEDED')).toBe(true)
      expect(fixture.database.connection.prepare('SELECT local_state FROM rag_documents WHERE document_id=?').get(fixture.task.id))
        .toEqual({ local_state: 'queued' })
    } finally {
      closeFixture(fixture.repository)
    }
  })

  it('does not create a canonical content job from a translation-only artifact', async () => {
    const fixture = await createFixture()
    try {
      fixture.repository.updateTask(fixture.task.id, { status: 'translating', progress: 1 })
      const translatedJob = fixture.database.connection.prepare(
        "SELECT id FROM jobs WHERE document_id=? AND kind='translate'"
      ).get(fixture.task.id) as { id: string }
      fixture.repository.recordArtifactRevision(
        fixture.task.id,
        'translated_markdown',
        join(fixture.task.outputDir, 'full.zh-CN.md'),
        'translation-hash',
        {},
        translatedJob.id
      )
      expect(fixture.database.connection.prepare("SELECT COUNT(*) AS count FROM jobs WHERE document_id=? AND kind='rag-content-index'").get(fixture.task.id))
        .toEqual({ count: 0 })
      expect(fixture.database.connection.prepare('SELECT COUNT(*) AS count FROM rag_content_revisions WHERE document_id=?').get(fixture.task.id))
        .toEqual({ count: 0 })
    } finally {
      closeFixture(fixture.repository)
    }
  })

  it('deletes all document-scoped RAG rows in the Utility transaction and leaves a succeeded tombstone', async () => {
    const fixture = await createFixture()
    try {
      const parse = fixture.database.connection.prepare("SELECT id FROM jobs WHERE document_id=? AND kind='parse'").get(fixture.task.id) as { id: string }
      fixture.database.connection.prepare("UPDATE jobs SET status='succeeded',progress=100,finished_at=?,updated_at=? WHERE id=?")
        .run('2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z', parse.id)
      fixture.repository.recordArtifactRevisions([
        { taskId: fixture.task.id, kind: 'parsed_markdown', path: join(fixture.task.outputDir, 'full.md'), checksum: 'content-hash', jobId: parse.id },
        { taskId: fixture.task.id, kind: 'block_mappings', path: join(fixture.task.outputDir, 'block_list.json'), checksum: 'mapping-hash', jobId: parse.id }
      ])
      // Include the normal parse -> translate dependency graph: document
      // deletion must still cascade all workflow jobs and RAG jobs safely.
      fixture.repository.updateTask(fixture.task.id, { status: 'translating', progress: 1 })
      fixture.repository.deleteTask(fixture.task.id)
      expect(fixture.database.connection.prepare('SELECT COUNT(*) AS count FROM documents WHERE id=?').get(fixture.task.id)).toEqual({ count: 0 })
      expect(fixture.database.connection.prepare('SELECT COUNT(*) AS count FROM rag_documents WHERE document_id=?').get(fixture.task.id)).toEqual({ count: 0 })
      expect(fixture.database.connection.prepare('SELECT COUNT(*) AS count FROM rag_content_revisions WHERE document_id=?').get(fixture.task.id)).toEqual({ count: 0 })
      expect(fixture.database.connection.prepare('SELECT COUNT(*) AS count FROM rag_vector_indexes WHERE document_id=?').get(fixture.task.id)).toEqual({ count: 0 })
      expect(fixture.database.connection.prepare('SELECT COUNT(*) AS count FROM rag_chunks').get()).toEqual({ count: 0 })
      expect(fixture.database.connection.prepare('SELECT COUNT(*) AS count FROM rag_chunk_variants').get()).toEqual({ count: 0 })
      expect(fixture.database.connection.prepare('SELECT COUNT(*) AS count FROM rag_embeddings').get()).toEqual({ count: 0 })
      expect(fixture.database.connection.prepare('SELECT state FROM rag_deletion_tombstones WHERE document_id=?').get(fixture.task.id))
        .toEqual({ state: 'succeeded' })
      expect(fixture.database.connection.prepare('PRAGMA foreign_key_check').all()).toEqual([])
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
