import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import archiver from 'archiver'
import { afterEach, describe, expect, it } from 'vitest'
import { SqliteJobRepository } from '../src/utility/core/persistence/sqliteJobRepository'
import { V2Database } from '../src/utility/core/persistence/v2Database'
import { V2TaskRepositoryCompat } from '../src/utility/core/persistence/v2TaskRepositoryCompat'
import { ParseJobRunner } from '../src/main/parseJobRunner'
import { TranslationJobRunner } from '../src/main/translationJobRunner'
import { PathPolicy } from '../src/main/pathPolicy'
import { SettingsService } from '../src/main/settingsService'
import { TaskService } from '../src/main/taskService'
import { DocumentCommandService } from '../src/main/documentCommandService'
import { MarkdownTranslationPlanManager } from '../src/utility/core/compute/markdownTranslationPlan'
import type { CredentialAccount, CredentialVault } from '../src/main/credentialVault'
import type { BatchResult, BatchSubmission, ParserClient } from '../src/main/parserClient'
import type { HealthResult, CopilotixTask } from '@shared/types'
import type { TaskComputePort } from '../src/core/ports'
import type { JobScheduler } from '../src/main/jobScheduler'
import type { TaskRepositoryCompat } from '../src/main/taskRepositoryCompat'
import { fixtureTaskCompute } from './taskComputeFixture'

const roots: string[] = []
const now = '2026-01-01T00:00:00.000Z'
const leaseExpiry = '2026-01-01T00:00:30.000Z'

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('durable TaskService cutover', () => {
  it('cancels the active translation before requeueing it and preserves its checkpoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilotix-running-retry-'))
    roots.push(root)
    const outputDir = join(root, 'document')
    await mkdir(outputDir, { recursive: true })
    const database = new V2Database(join(root, 'db.sqlite3'))
    const repository = new V2TaskRepositoryCompat(database)
    const jobs = new SqliteJobRepository(database)
    const task = makeTask(outputDir, join(outputDir, 'original.pdf'))
    repository.insertTask(task)
    const checkpoint = { stage: 'translating', totalBlocks: 100, completedBlocks: 45, failedBlocks: 2, failedBlockIds: ['failed-block'] }
    const job = jobs.enqueue({ documentId: task.id, kind: 'translate', now })
    jobs.claimBatch({ now, leaseOwner: 'runner', leaseExpiresAt: leaseExpiry, kind: 'translate' })
    jobs.updateProgressAndCheckpoint({ jobId: job.id, leaseOwner: 'runner', progress: 71, checkpoint, now })
    const calls: string[] = []
    const scheduler = {
      cancel: async (jobId: string) => {
        calls.push('cancel')
        jobs.cancel({ jobId, leaseOwner: 'runner', now })
      },
      wake: () => { calls.push('wake') }
    } as unknown as JobScheduler
    const commands = new DocumentCommandService(repository, {} as SettingsService, fixtureTaskCompute, new PathPolicy(),
      { info: () => undefined, error: () => undefined }, { jobRepository: jobs, scheduler })
    try {
      await commands.retry(task.id)
      expect(calls).toEqual(['cancel', 'wake'])
      expect(jobs.get(job.id)).toMatchObject({ status: 'queued', progress: 0, checkpoint })
      expect(jobs.list({ documentId: task.id, kind: 'translate' })).toHaveLength(1)
    } finally {
      database.close()
    }
  })

  it('forwards legacy document notifications only for parse and translate jobs', () => {
    const scheduler = new EventEmitter() as unknown as JobScheduler
    const service = new TaskService(
      {} as TaskRepositoryCompat,
      {} as SettingsService,
      {} as CredentialVault,
      {} as ParserClient,
      async () => new Response(),
      fixtureTaskCompute,
      undefined,
      undefined,
      { scheduler }
    )
    const notifications: Array<[string, string]> = []
    service.on('notification', (taskId: string, status: string) => notifications.push([taskId, status]))

    scheduler.emit('job-notification', 'parse-failed', 'failed', 'parse')
    scheduler.emit('job-notification', 'translation-complete', 'succeeded', 'translate')
    scheduler.emit('job-notification', 'translation-partial', 'partial', 'translate')
    scheduler.emit('job-notification', 'rag-content-failed', 'failed', 'rag-content-index')
    scheduler.emit('job-notification', 'rag-content-complete', 'succeeded', 'rag-content-index')
    scheduler.emit('job-notification', 'rag-embed-failed', 'failed', 'rag-embed')
    scheduler.emit('job-notification', 'rag-delete-complete', 'succeeded', 'rag-delete')

    expect(notifications).toEqual([
      ['parse-failed', 'failed'],
      ['translation-complete', 'completed'],
      ['translation-partial', 'partial']
    ])
  })

  it('creates exactly one queued parse job without a legacy execution queue', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilotix-durable-create-'))
    roots.push(root)
    const source = join(root, 'paper.pdf')
    await writeFile(source, '%PDF-1.4 fixture')
    const database = new V2Database(join(root, 'copilotix.sqlite3'))
    const repository = new V2TaskRepositoryCompat(database)
    const jobs = new SqliteJobRepository(database)
    const vault = new MemoryVault({ 'parser-token': 'parser-token' })
    const settings = new SettingsService(repository, vault, join(root, 'output'))
    const client = new NeverCalledClient()
    const service = new TaskService(repository, settings, vault, client, async () => new Response(), fixtureTaskCompute, undefined, undefined, { jobRepository: jobs })

    try {
      const created = await service.create({
        files: [{ path: source, name: 'paper.pdf', size: 16 }],
        createDuplicates: false,
        useOriginalFilename: true
      })
      expect(created[0]).toMatchObject({ originalName: 'paper.pdf', title: 'paper' })
      const parseJobs = jobs.list({ documentId: created[0]!.id, kind: 'parse' })
      expect(parseJobs).toHaveLength(1)
      expect(parseJobs[0]).toMatchObject({ status: 'queued', attempt: 0 })
      expect(client.createCalls).toBe(0)

      const duplicate = await service.create({
        files: [{ path: source, name: 'renamed-copy.pdf', size: 16 }],
        createDuplicates: false
      })
      expect(duplicate).toEqual([])
      expect(repository.listTasks()).toHaveLength(1)
    } finally {
      database.close()
    }
  })

  it('resumes a remote checkpoint without resubmitting and runs one dependent translation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilotix-durable-resume-'))
    roots.push(root)
    const outputDir = join(root, 'document')
    const sourcePath = join(outputDir, 'original.pdf')
    await mkdir(outputDir, { recursive: true })
    await writeFile(sourcePath, '%PDF-1.4 fixture')
    const database = new V2Database(join(root, 'copilotix.sqlite3'))
    const repository = new V2TaskRepositoryCompat(database)
    const jobs = new SqliteJobRepository(database)
    const task = makeTask(outputDir, sourcePath)
    repository.insertTask(task)
    const claimedParse = jobs.claimBatch({ now, leaseOwner: 'runner', leaseExpiresAt: leaseExpiry, kind: 'parse' })[0]!
    const checkpointed = jobs.updateProgressAndCheckpoint({
      jobId: claimedParse.id,
      leaseOwner: 'runner',
      progress: 10,
      checkpoint: { stage: 'polling', remoteBatchId: 'remote-batch', remoteDataId: task.id },
      now
    })
    const vault = new MemoryVault({ 'parser-token': 'parser-token', 'qwen-api-key': 'qwen-key' })
    const settings = new SettingsService(repository, vault, join(root, 'output'), {
      parser: async () => ({ ok: true, message: 'Token 验证成功' }),
      provider: async () => ({ ok: true, message: 'API Key 验证成功' })
    })
    await settings.validateCredential('parser')
    await settings.validateCredential('qwen')
    const client = new ResumeClient(await resultZip())
    const normalizedJobIds: string[] = []
    const planManager = new MarkdownTranslationPlanManager(repository)
    const compute: TaskComputePort = {
      ...fixtureTaskCompute,
      async normalizeParserOutput(task, extractedDir, jobId) {
        if (!jobId) throw new Error('parse artifact test requires an explicit job id')
        normalizedJobIds.push(jobId)
        const parsedPath = join(task.outputDir, 'full.md')
        const result = await fixtureTaskCompute.normalizeParserOutput(task, extractedDir, jobId)
        repository.recordArtifactRevision!(task.id, 'parsed_markdown', parsedPath, await fixtureTaskCompute.hashFile(parsedPath), {}, jobId)
        return result
      },
      openTranslationPlan: (taskId, jobId) => planManager.open(taskId, jobId),
      listTranslationWork: (taskId, jobId, cursor, limit) => planManager.listWork(taskId, jobId, cursor, limit),
      tryTranslationCache: (taskId, jobId, unitId, provider, model) => planManager.tryCache(taskId, jobId, unitId, provider, model),
      applyTranslation: (taskId, jobId, unitId, responsePath, provider, model) => planManager.apply(taskId, jobId, unitId, responsePath, provider, model),
      failTranslation: (taskId, jobId, unitId, error) => planManager.fail(taskId, jobId, unitId, error),
      finalizeTranslation: (taskId, jobId) => planManager.finalize(taskId, jobId)
    }
    const fetcher = async (input: string | URL | Request): Promise<Response> => {
      if (String(input).includes('/chat/completions')) {
        return new Response(JSON.stringify({ choices: [{ message: { content: '这是译文' } }] }), { status: 200 })
      }
      return new Response('', { status: 200 })
    }
    const parseRunner = new ParseJobRunner({
      repository,
      jobRepository: jobs,
      settingsService: settings,
      vault,
      parserClient: client,
      compute,
      pathPolicy: new PathPolicy()
    })

    try {
      const parseResult = await parseRunner.run({
        job: checkpointed,
        signal: new AbortController().signal,
        updateProgress: async (progress, checkpoint) => jobs.updateProgressAndCheckpoint({ jobId: checkpointed.id, leaseOwner: 'runner', progress, checkpoint, now })
      })
      expect(client.createCalls).toBe(0)
      expect(parseResult.status).toBe('succeeded')
      expect(normalizedJobIds).toEqual([checkpointed.id])
      expect(database.connection.prepare(
        "SELECT created_by_job_id FROM artifacts WHERE document_id=? AND kind='parsed_markdown'"
      ).get(task.id)).toEqual({ created_by_job_id: checkpointed.id })
      const completedParse = jobs.complete({ jobId: checkpointed.id, leaseOwner: 'runner', status: 'succeeded', progress: 100, checkpoint: parseResult.checkpoint, now })
      const translateJobs = jobs.list({ documentId: task.id, kind: 'translate' })
      expect(translateJobs).toHaveLength(1)
      expect(translateJobs[0]!.dependsOnJobId).toBe(completedParse.id)

      const claimNow = new Date().toISOString()
      const translate = jobs.claimBatch({ now: claimNow, leaseOwner: 'runner', leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(), kind: 'translate' })[0]!
      const translationRunner = new TranslationJobRunner({
        repository,
        settingsService: settings,
        vault,
        fetcher,
        compute,
        pathPolicy: new PathPolicy()
      })
      const translationResult = await translationRunner.run({
        job: translate,
        signal: new AbortController().signal,
        updateProgress: async (progress, checkpoint) => jobs.updateProgressAndCheckpoint({ jobId: translate.id, leaseOwner: 'runner', progress, checkpoint, now })
      })
      expect(translationResult.status).toBe('succeeded')
      expect(database.connection.prepare(
        "SELECT kind,created_by_job_id FROM artifacts WHERE document_id=? AND kind IN ('translated_markdown','manifest') ORDER BY kind"
      ).all(task.id)).toEqual([
        { kind: 'manifest', created_by_job_id: translate.id },
        { kind: 'translated_markdown', created_by_job_id: translate.id }
      ])
      expect(jobs.list({ documentId: task.id, kind: 'translate' })).toHaveLength(1)
      expect(repository.listTranslationBlocks(task.id, translate.id).every((block) => block.jobId === undefined || block.jobId === translate.id)).toBe(true)
      await expect(readFile(join(outputDir, 'full.zh-CN.md'), 'utf8')).resolves.toContain('译文')
    } finally {
      database.close()
    }
  })

  it('always deletes the database document, while deleteFiles only controls its directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilotix-delete-boundary-'))
    roots.push(root)
    const outputRoot = join(root, 'output')
    const documentsRoot = join(outputRoot, 'documents-v2')
    await mkdir(documentsRoot, { recursive: true })
    const database = new V2Database(join(root, 'copilotix.sqlite3'))
    const repository = new V2TaskRepositoryCompat(database)
    const settings = new SettingsService(repository, new MemoryVault({}), outputRoot)

    const firstDir = join(documentsRoot, 'document-delete-keep')
    await mkdir(firstDir, { recursive: true })
    await writeFile(join(firstDir, 'artifact.md'), 'keep')
    const firstTask = makeTask(firstDir, join(firstDir, 'original.pdf'))
    repository.insertTask({ ...firstTask, id: 'document-delete-keep' })

    const secondDir = join(documentsRoot, 'document-delete-files')
    await mkdir(secondDir, { recursive: true })
    await writeFile(join(secondDir, 'artifact.md'), 'remove')
    const secondTask = makeTask(secondDir, join(secondDir, 'original.pdf'))
    repository.insertTask({ ...secondTask, id: 'document-delete-files' })

    const service = new TaskService(
      repository,
      settings,
      new MemoryVault({}),
      new NeverCalledClient(),
      async () => new Response(),
      fixtureTaskCompute,
      new PathPolicy()
    )
    try {
      await service.delete('document-delete-keep', false)
      expect(repository.getTask('document-delete-keep')).toBeNull()
      await expect(stat(firstDir)).resolves.toBeTruthy()

      await service.delete('document-delete-files', true)
      expect(repository.getTask('document-delete-files')).toBeNull()
      await expect(stat(secondDir)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      database.close()
    }
  })
})

class MemoryVault implements CredentialVault {
  constructor(private readonly values: Partial<Record<CredentialAccount, string>>) {}

  async get(account: CredentialAccount): Promise<string | null> { return this.values[account] ?? null }
  async set(account: CredentialAccount, value: string): Promise<void> { this.values[account] = value }
  async delete(account: CredentialAccount): Promise<void> { delete this.values[account] }
  async has(account: CredentialAccount): Promise<boolean> { return Boolean(this.values[account]) }
}

class NeverCalledClient implements ParserClient {
  createCalls = 0
  async verifyToken(): Promise<HealthResult> { return { ok: true, message: 'unused' } }
  async createUploadBatch(): Promise<BatchSubmission> { this.createCalls += 1; throw new Error('legacy queue must not call parser') }
  async uploadFile(): Promise<void> { throw new Error('unused') }
  async getBatchResult(_batchId: string): Promise<BatchResult> { throw new Error('unused') }
  async waitForBatch(_batchId: string, _token: string, _expectedDataIds: Set<string>, _onUpdate: (result: BatchResult) => void): Promise<BatchResult> { throw new Error('unused') }
  async downloadResult(_resultUrl: string, _destinationPath: string): Promise<void> { throw new Error('unused') }
}

class ResumeClient extends NeverCalledClient {
  constructor(private readonly zip: Uint8Array) { super() }

  override async getBatchResult(batchId: string): Promise<BatchResult> {
    return { batchId, entries: [{ dataId: '00000000-0000-4000-8000-000000000001', fileName: 'paper.pdf', state: 'pending', fullZipUrl: null, error: null, progress: null }] }
  }

  override async waitForBatch(batchId: string, _token: string, expectedDataIds: Set<string>, onUpdate: (result: BatchResult) => void): Promise<BatchResult> {
    const result: BatchResult = {
      batchId,
      entries: [...expectedDataIds].map((dataId) => ({ dataId, fileName: 'paper.pdf', state: 'done' as const, fullZipUrl: 'https://cdn.example.test/result.zip', error: null, progress: null }))
    }
    onUpdate(result)
    return result
  }

  override async downloadResult(_resultUrl: string, destinationPath: string): Promise<void> { await writeFile(destinationPath, this.zip) }
}

function makeTask(outputDir: string, sourcePath: string): CopilotixTask {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    originalName: 'paper.pdf',
    title: null,
    name: 'paper.pdf',
    sourcePath,
    sourceHash: 'fixture-hash',
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

async function resultZip(): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } })
    const output = new PassThrough()
    const chunks: Buffer[] = []
    output.on('data', (chunk: Buffer) => chunks.push(chunk))
    output.on('end', () => resolve(Buffer.concat(chunks)))
    output.on('error', reject)
    archive.on('error', reject)
    archive.pipe(output)
    archive.append('# Resume Title\n\nEnglish paragraph.\n', { name: 'result/full.md' })
    archive.append(JSON.stringify({ pdf_info: [] }), { name: 'result/middle.json' })
    void archive.finalize()
  })
}
