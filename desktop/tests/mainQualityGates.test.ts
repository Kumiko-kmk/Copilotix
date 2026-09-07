import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ArtifactService } from '@main/artifactService'
import { DocumentCommandService } from '@main/documentCommandService'
import { isTrustedRendererUrl, sendValidatedEvent, toIpcError } from '@main/ipc'
import { AsyncSemaphore, fullJitterExponentialBackoff, JobScheduler } from '@main/jobScheduler'
import { JsonLineLogger } from '@main/logger'
import { PathPolicy } from '@main/pathPolicy'
import { ParseJobRunner } from '@main/parseJobRunner'
import { projectDocumentDetails, projectDocumentSummary } from '@main/documentProjection'
import { RpcJobRepository } from '@main/rpcJobRepository'
import { RpcTaskCompute } from '@main/rpcTaskCompute'
import { RpcTaskRepository } from '@main/rpcTaskRepository'
import { SettingsService } from '@main/settingsService'
import { splitIntoMinerUBatches } from '@main/taskService'
import { canTransition, JobRunnerError } from '@core/jobs'
import { BLOCK_MAPPING_VERSION } from '@core/blockMapping'
import type { TaskComputePort } from '@core/ports'
import type { Job } from '@core/types'
import type { JobRepositoryPort } from '@core/jobs'
import type { DocumentPayload, MinerUTask } from '@shared/types'
import { z } from 'zod'
import { MARKDOWN_MAPPING_ALGORITHM_VERSION } from '@shared/markdownBlocks'
import { TABLE_TRANSLATION_PROTOCOL, TRANSLATION_PIPELINE_VERSION } from '@shared/translationPlanProtocol'
import type { UtilitySupervisor } from '@main/utilitySupervisor'
import type { TaskRepositoryCompat } from '@main/taskRepositoryCompat'
import type { CredentialAccount, CredentialVault } from '@main/credentialVault'

const keyring = vi.hoisted(() => ({
  values: new Map<string, string>(),
  failures: new Set<string>()
}))

vi.mock('@napi-rs/keyring', () => ({
  Entry: class FakeEntry {
    constructor(
      private readonly service: string,
      private readonly account: string
    ) {}

    private get key(): string {
      return this.service + ':' + this.account
    }

    getPassword(): string | null {
      if (keyring.failures.has(this.key)) throw new Error('keyring unavailable')
      return keyring.values.get(this.key) ?? null
    }

    setPassword(value: string): void {
      if (keyring.failures.has(this.key)) throw new Error('keyring unavailable')
      keyring.values.set(this.key, value)
    }

    deletePassword(): void {
      if (keyring.failures.has(this.key)) throw new Error('keyring unavailable')
      keyring.values.delete(this.key)
    }
  }
}))

const now = '2026-01-01T00:00:00.000Z'
const baseTask: MinerUTask = {
  id: '00000000-0000-4000-8000-000000000099',
  originalName: 'paper.pdf',
  title: null,
  name: 'paper.pdf',
  sourcePath: 'C:\\paper.pdf',
  sourceHash: 'source-hash',
  outputDir: 'C:\\output\\task-quality',
  status: 'completed',
  progress: 100,
  translationProvider: 'qwen',
  remoteBatchId: null,
  remoteDataId: null,
  remoteResultUrl: null,
  error: null,
  createdAt: now,
  updatedAt: now
}

const baseSettings = {
  hasParserToken: false,
  outputRoot: 'C:\\output',
  formulaEnabled: true,
  tableEnabled: true,
  translationProvider: 'qwen' as const,
  qwenBaseUrl: 'https://qwen.example.test',
  qwenModel: 'qwen-model',
  qwenHasApiKey: false,
  deepseekBaseUrl: 'https://deepseek.example.test',
  deepseekModel: 'deepseek-model',
  deepseekHasApiKey: false
}

const roots: string[] = []

afterEach(async () => {
  keyring.values.clear()
  keyring.failures.clear()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('main quality boundaries', () => {
  it('sanitizes JSON line logs and keeps append failures non-fatal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mineru-quality-logger-'))
    roots.push(root)
    const path = join(root, 'events.jsonl')
    const logger = new JsonLineLogger(path)
    logger.info('request', {
      token: 'secret-token',
      nested: ['Bearer abc', 'https://example.test/path?token=secret', 'C:\\private\\paper.pdf', '/tmp/private.txt']
    })
    logger.error('failure', new Error('failed'), { apiKey: 'secret-key' })
    await (logger as unknown as { pending: Promise<void> }).pending
    const lines = (await readFile(path, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ level: 'info', token: '[REDACTED]' })
    expect(lines[0]?.nested).toEqual(['[REDACTED]', 'http[path]', '[path]', '[path]'])
    expect(lines[1]).toMatchObject({ level: 'error', apiKey: '[REDACTED]', error: 'failed' })
    const missing = new JsonLineLogger(join(root, 'missing', 'events.jsonl'))
    missing.info('ignored')
    await (missing as unknown as { pending: Promise<void> }).pending
  })

  it('uses the platform credential vault contract without leaking native failures', async () => {
    const { WindowsCredentialVault } = await import('@main/credentialVault')
    const vault: CredentialVault = new WindowsCredentialVault()
    await expect(vault.get('parser-token')).resolves.toBeNull()
    await vault.set('parser-token', '  parser-secret  ')
    await expect(vault.get('parser-token')).resolves.toBe('parser-secret')
    await expect(vault.has('parser-token')).resolves.toBe(true)
    await vault.set('parser-token', '   ')
    await expect(vault.has('parser-token')).resolves.toBe(false)
    keyring.failures.add('MinerU Desktop:deepseek-api-key')
    await expect(vault.get('deepseek-api-key')).resolves.toBeNull()
    await expect(vault.delete('deepseek-api-key')).resolves.toBeUndefined()
  })

  it('forwards every compute and repository RPC without sending document bodies', async () => {
    const calls: Array<{ operation: string; payload: unknown; options?: unknown }> = []
    const supervisor = {
      request: async (operation: string, payload: unknown, options?: unknown): Promise<unknown> => {
        calls.push({ operation, payload, options })
        if (operation === 'compute:hash-file') return { sha256: 'hash' }
        if (operation === 'compute:import-pdf') return { sha256: 'hash', size: 12 }
        if (operation === 'translation:cache-get') return { translated: 'cached' }
        if (operation === 'tasks:get' || operation === 'documents:get-summary' || operation === 'artifacts:get-latest') return null
        if (operation === 'jobs:list' || operation === 'jobs:claim-batch' || operation === 'jobs:recover-expired') return []
        if (operation === 'tasks:list' || operation === 'documents:list' || operation === 'translation:blocks-list' || operation === 'annotations:list' || operation === 'annotations:replace') return []
        return operation === 'tasks:update' ? baseTask : undefined
      }
    } as unknown as UtilitySupervisor

    const compute = new RpcTaskCompute(supervisor)
    await expect(compute.hashFile('input.pdf')).resolves.toBe('hash')
    await expect(compute.importPdf('input.pdf', 'task')).resolves.toEqual({ sha256: 'hash', size: 12 })
    await compute.normalizeParserOutput(baseTask, 'extracted')
    await compute.normalizeParserOutput(baseTask, 'extracted', 'job')
    await compute.rebuildMappings('task', 'output')
    await compute.openTranslationPlan('task', 'job')
    await compute.listTranslationWork('task', 'job')
    await compute.listTranslationWork('task', 'job', 1, 32)
    await compute.tryTranslationCache('task', 'job', 'unit', 'qwen', 'model')
    await compute.applyTranslation('task', 'job', 'unit')
    await compute.applyTranslation('task', 'job', 'unit', '.translation/response.json', 'qwen', 'model')
    await compute.failTranslation('task', 'job', 'unit')
    await compute.failTranslation('task', 'job', 'unit', 'error')
    await compute.finalizeTranslation('task', 'job')

    const repository = new RpcTaskRepository(supervisor)
    await repository.close()
    await repository.getSettings('output')
    await repository.saveSettings(baseSettings)
    await repository.listTasks()
    await repository.getTask('task')
    await repository.findByHash('hash')
    await repository.listDocumentSummaries()
    await repository.getDocumentSummary('task')
    await repository.getLatestArtifactReference('task', 'layout')
    await repository.listDocumentAnnotations({ documentId: 'task', view: 'original' })
    await repository.mutateDocumentAnnotations({ documentId: 'task', artifactId: 'artifact', view: 'original', expectedRevision: 0, upserts: [], deleteIds: [] })
    await repository.insertTask(baseTask)
    await repository.insertTasks([baseTask])
    await repository.updateDocumentMetadata('task', { displayTitle: 'title' })
    await repository.updateTask('task', { error: null })
    await repository.deleteTask('task')
    await repository.upsertTranslationBlock({ taskId: 'task', blockId: 'block', sourceHash: 'hash', sourceMarkdown: 'text', translatedMarkdown: null, provider: null, model: null, status: 'pending', error: null })
    await repository.commitTranslationBatch({ taskId: 'task', jobId: 'job', blocks: [], cacheEntries: [] })
    await repository.listTranslationBlocks('task')
    await repository.listTranslationBlocks('task', 'job')
    await repository.updateTranslationRun('task', 1, 1, 0)
    await expect(repository.getCache('key')).resolves.toBe('cached')
    await repository.putCache('key', 'translated', 'qwen', 'model')
    await repository.listReaderAnnotations('task')
    await repository.replaceReaderAnnotations({ taskId: 'task', view: 'original', annotations: [] })
    await repository.recordArtifactRevision('task', 'layout', 'layout.json', 'hash')
    await repository.recordArtifactRevision('task', 'layout', 'layout.json', 'hash', { source: 'test' }, 'job')

    const jobs = new RpcJobRepository(supervisor)
    const jobInput = { jobId: 'job', leaseOwner: 'owner', leaseExpiresAt: now }
    await jobs.enqueue({ documentId: 'task', kind: 'parse' })
    await jobs.get('job')
    await jobs.list()
    await jobs.list({ statuses: ['queued'], kind: 'parse' })
    await jobs.claimBatch({ now, ...jobInput })
    await jobs.heartbeat(jobInput)
    await jobs.updateProgressAndCheckpoint({ ...jobInput, progress: 1, checkpoint: {} })
    await jobs.complete({ ...jobInput, status: 'succeeded' })
    await jobs.failOrRetry({ ...jobInput, errorCode: 'E', errorMessage: 'error' })
    await jobs.cancel(jobInput)
    await jobs.manualRetry({ jobId: 'job' })
    await jobs.recoverExpired({ now })
    await jobs.listEvents('job')

    expect(calls.some((call) => call.operation === 'compute:translation-plan-open' && call.payload === 'full.md')).toBe(false)
    expect(calls.map((call) => call.operation)).toContain('translation:batch-commit')
    expect(calls.map((call) => call.operation)).toContain('jobs:cancel')
  })

  it('loads and atomically writes bounded artifact projections', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mineru-quality-artifacts-'))
    roots.push(root)
    const task = { ...baseTask, outputDir: root }
    const blockPath = join(root, 'block_list.json')
    const mapping = { id: 'mapping-1', order: 0, type: 'text', sourceText: 'source', boxes: [] }
    const compute = {
      hashFile: vi.fn(async () => 'checksum'),
      rebuildMappings: vi.fn(async () => {
        await writeFile(blockPath, JSON.stringify({ version: BLOCK_MAPPING_VERSION, mappings: [mapping] }), 'utf8')
      })
    } as unknown as TaskComputePort
    const revisions: unknown[] = []
    const repository = {
      getTask: async (taskId: string) => taskId === task.id ? task : null,
      recordArtifactRevision: async (...args: unknown[]) => { revisions.push(args) }
    } as unknown as TaskRepositoryCompat
    const service = new ArtifactService(repository, compute, new PathPolicy())
    await writeFile(join(root, 'full.md'), '# Source', 'utf8')
    await writeFile(join(root, 'full.zh-CN.md'), '# 译文', 'utf8')
    await writeFile(join(root, 'layout.json'), '{"pages":[]}', 'utf8')
    await writeFile(blockPath, JSON.stringify({ version: BLOCK_MAPPING_VERSION, mappings: [mapping] }), 'utf8')
    await writeFile(join(root, 'translation.manifest.json'), JSON.stringify({
      version: 2,
      taskId: task.id,
      translationPipelineVersion: TRANSLATION_PIPELINE_VERSION,
      tableTranslationProtocol: TABLE_TRANSLATION_PROTOCOL,
      mappingAlgorithmVersion: MARKDOWN_MAPPING_ALGORITHM_VERSION,
      blockMappingVersion: BLOCK_MAPPING_VERSION,
      blocks: [{ sourceIndex: 0, markdown: '# 译文', mappingIds: ['mapping-1'] }]
    }), 'utf8')

    const payload = await service.getDocument(task.id)
    expect(payload.markdown).toBe('# Source')
    expect(payload.translatedBlocks).toEqual([{ sourceIndex: 0, markdown: '# 译文', mappingIds: ['mapping-1'] }])

    await writeFile(join(root, 'translation.manifest.json'), JSON.stringify({
      version: 2,
      taskId: task.id,
      translationPipelineVersion: TRANSLATION_PIPELINE_VERSION,
      tableTranslationProtocol: TABLE_TRANSLATION_PROTOCOL,
      mappingAlgorithmVersion: MARKDOWN_MAPPING_ALGORITHM_VERSION,
      blockMappingVersion: BLOCK_MAPPING_VERSION - 1,
      blocks: [{ sourceIndex: 0, markdown: '# 译文', mappingIds: ['stale-mapping'] }]
    }), 'utf8')
    await expect(service.loadTranslatedBlocks(task)).resolves.toEqual([
      { sourceIndex: 0, markdown: '# 译文', mappingIds: [] }
    ])

    expect(await service.resolveAsset(task.id, '/images/figure.png')).toBe(join(root, 'images', 'figure.png'))
    await service.recordArtifact(task, 'parsed_markdown', join(root, 'full.md'), 'job')
    expect(revisions).toHaveLength(1)
    await service.atomicWriteJson(join(root, 'atomic.json'), { ok: true })
    await expect(readFile(join(root, 'atomic.json'), 'utf8')).resolves.toContain('"ok": true')

    await writeFile(blockPath, '{"version":2,"mappings":[]}', 'utf8')
    await expect(service.loadMappings(task)).resolves.toEqual([mapping])
    await writeFile(join(root, 'translation.manifest.json'), '{"version":2}', 'utf8')
    await expect(service.loadTranslatedBlocks(task)).resolves.toEqual(null)
    await rm(join(root, 'translation.manifest.json'), { force: true })
    compute.rebuildMappings = vi.fn(async () => { throw new Error('rebuild failed') }) as unknown as TaskComputePort['rebuildMappings']
    await rm(blockPath, { force: true })
    await expect(service.loadMappings(task)).resolves.toEqual([])
    await expect(service.readOptional(join(root, 'missing.txt'), 'fallback')).resolves.toBe('fallback')
    await expect(service.getDocument('missing')).rejects.toThrow('任务不存在')
  })

  it('projects document DTOs and exercises stable job transition/error contracts', () => {
    const summary = projectDocumentSummary(baseTask)
    expect(summary).not.toHaveProperty('sourcePath')
    const payload: DocumentPayload = {
      task: baseTask,
      markdown: '# Source',
      translatedMarkdown: '# Translation',
      translatedBlocks: [],
      layoutJson: '{}',
      mappings: [],
      pdfUrl: 'mineru-asset://task/original.pdf',
      assetBaseUrl: 'mineru-asset://task/'
    }
    expect(projectDocumentDetails(payload).summary.id).toBe(baseTask.id)
    expect(canTransition(null, 'queued')).toBe(true)
    expect(canTransition('running', 'queued')).toBe(false)
    expect(canTransition('running', 'queued', false, true)).toBe(true)
    expect(canTransition('failed', 'queued', true)).toBe(true)
    expect(canTransition('failed', 'queued')).toBe(false)
    expect(new JobRunnerError('failed', 'TEST', true)).toMatchObject({ code: 'TEST', retryable: true })
  })

  it('normalizes settings credentials, batches, and optional account operations', async () => {
    const saved: unknown[] = []
    const repository = {
      getSettings: async () => ({ ...baseSettings }),
      saveSettings: async (value: unknown) => { saved.push(value) }
    } as unknown as TaskRepositoryCompat
    const values = new Map<CredentialAccount, string>([['parser-token', 'parser']])
    const vault: CredentialVault = {
      get: async (account) => values.get(account) ?? null,
      set: async (account, value) => { values.set(account, value) },
      delete: async (account) => { values.delete(account) },
      has: async (account) => values.has(account)
    }
    const service = new SettingsService(repository, vault, 'C:\\default-output')
    await expect(service.get()).resolves.toMatchObject({ hasParserToken: true, qwenHasApiKey: false })
    await service.save({
      parserToken: ' parser-next ',
      clearQwenApiKey: true,
      deepseekApiKey: 'deepseek',
      outputRoot: 'C:\\new-output',
      formulaEnabled: true,
      tableEnabled: false,
      translationProvider: 'deepseek',
      qwenBaseUrl: 'https://qwen.example.test',
      qwenModel: 'qwen',
      deepseekBaseUrl: 'https://deepseek.example.test',
      deepseekModel: 'deepseek'
    })
    expect(values.get('parser-token')).toBe(' parser-next ')
    expect(values.get('deepseek-api-key')).toBe('deepseek')
    expect(saved).toHaveLength(1)
    expect(splitIntoMinerUBatches([1, 2, 3], 2)).toEqual([[1, 2], [3]])
    expect(() => splitIntoMinerUBatches([], 0)).toThrow('Batch size')
  })

  it('exercises document commands across duplicate, retry, import, and deletion paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mineru-quality-commands-'))
    roots.push(root)
    const source = join(root, 'paper.pdf')
    const duplicateSource = join(root, 'duplicate.pdf')
    const textFile = join(root, 'notes.txt')
    await writeFile(source, '%PDF-1.4 source')
    await writeFile(duplicateSource, '%PDF-1.4 duplicate')
    await writeFile(textFile, 'not a PDF')

    const settings = { ...baseSettings, hasParserToken: true, outputRoot: join(root, 'output') }
    const tasks = new Map<string, MinerUTask>()
    const enqueued: unknown[] = []
    const job = {
      id: 'job-retry',
      documentId: baseTask.id,
      kind: 'translate',
      status: 'failed',
      updatedAt: now
    } as unknown as Job
    const repository = {
      listTasks: async () => [...tasks.values()],
      findByHash: async (hash: string) => hash === 'existing-hash' ? baseTask : null,
      insertTasks: async (created: MinerUTask[]) => { for (const task of created) tasks.set(task.id, task) },
      getTask: async (id: string) => id === baseTask.id ? { ...baseTask, outputDir: join(root, 'output', 'documents-v2', baseTask.id) } : tasks.get(id) ?? null,
      updateTask: async (id: string, patch: Partial<MinerUTask>) => ({ ...baseTask, id, ...patch }),
      deleteTask: async (id: string) => { tasks.delete(id) }
    } as unknown as TaskRepositoryCompat
    const compute = {
      hashFile: async (path: string) => path === duplicateSource ? 'existing-hash' : 'new-hash',
      importPdf: async (_path: string, id: string) => ({ sha256: 'imported-hash', size: 12 + id.length })
    } as unknown as TaskComputePort
    const jobs = {
      list: async (query: { documentId?: string }) => query.documentId === baseTask.id ? [job] : [],
      enqueue: async (input: unknown) => { enqueued.push(input); return job },
      manualRetry: async (input: unknown) => { enqueued.push(input); return job }
    } as unknown as JobRepositoryPort
    const scheduler = { wake: vi.fn(), cancelDocument: vi.fn(async () => undefined) } as unknown as import('@main/jobScheduler').JobScheduler
    const logger = { info: vi.fn(), error: vi.fn() }
    const service = new DocumentCommandService(
      repository,
      { get: async () => settings } as never,
      compute,
      new PathPolicy(),
      logger,
      { jobRepository: jobs, scheduler }
    )

    await expect(service.list()).resolves.toEqual([])
    await expect(service.inspectPdfs([source])).resolves.toMatchObject([{ name: 'paper.pdf', size: 15 }])
    await expect(service.create({
      files: [
        { path: source, name: 'paper.pdf', size: 15 },
        { path: textFile, name: 'notes.txt', size: 9 }
      ],
      translationProvider: 'qwen'
    })).resolves.toHaveLength(1)
    expect(enqueued.length).toBeGreaterThan(0)
    expect(scheduler.wake).toHaveBeenCalled()
    await expect(service.importPaths([duplicateSource, duplicateSource, textFile], {
      translationProvider: 'deepseek'
    })).resolves.toHaveLength(1)
    await expect(service.retry(baseTask.id)).resolves.toBeUndefined()
    await expect(service.retry('missing')).rejects.toThrow('任务不存在')
    const noRetryJobs = { ...jobs, list: async () => [] } as unknown as JobRepositoryPort
    const noRetryService = new DocumentCommandService(repository, { get: async () => settings } as never, compute, new PathPolicy(), logger, { jobRepository: noRetryJobs })
    await expect(noRetryService.retry(baseTask.id)).rejects.toThrow('不可重试')
    await expect(service.delete(baseTask.id, false)).resolves.toBeUndefined()
    await expect(service.delete('missing', true)).resolves.toBeUndefined()

    const noTokenService = new DocumentCommandService(
      repository,
      { get: async () => ({ ...settings, hasParserToken: false }) } as never,
      compute,
      new PathPolicy(),
      logger
    )
    await expect(noTokenService.create({ files: [], translationProvider: 'qwen' })).rejects.toThrow('Token')
  })

  it('covers IPC URL/error/event boundary cases', () => {
    const entry = resolve('renderer/index.html')
    expect(isTrustedRendererUrl('not a URL', { rendererEntryPath: entry })).toBe(false)
    expect(isTrustedRendererUrl('https://renderer.test/page', { rendererEntryPath: entry, rendererOrigin: 'https://renderer.test/' })).toBe(true)
    expect(isTrustedRendererUrl('https://other.test/page', { rendererEntryPath: entry, rendererOrigin: 'https://renderer.test/' })).toBe(false)
    const traceId = '00000000-0000-4000-8000-000000000098'
    expect(toIpcError(new Error(''), 'HANDLER_ERROR', traceId)).toMatchObject({ code: 'HANDLER_ERROR', message: 'IPC 请求失败', traceId })
    expect(toIpcError({ code: 'DOMAIN' }, 'HANDLER_ERROR', traceId)).toMatchObject({ code: 'DOMAIN', retryable: false })
    const send = vi.fn()
    const contents = { mainFrame: { url: 'file:///renderer/index.html' }, getURL: () => 'file:///renderer/index.html', isDestroyed: () => false, send }
    sendValidatedEvent(contents, 'event', z.object({ ok: z.boolean() }), { ok: true })
    sendValidatedEvent({ ...contents, isDestroyed: () => true }, 'event', z.object({ ok: z.boolean() }), { ok: true })
    expect(send).toHaveBeenCalledOnce()
  })

  it('covers semaphore cancellation, jitter bounds, scheduler completion, and failure', async () => {
    expect(() => new AsyncSemaphore(0)).toThrow('Semaphore limit')
    const semaphore = new AsyncSemaphore(1)
    const release = await semaphore.acquire()
    expect(semaphore.tryAcquire()).toBe(false)
    const waiting = semaphore.acquire()
    release()
    const releaseWaiting = await waiting
    releaseWaiting()
    const controller = new AbortController()
    const holder = await semaphore.acquire()
    const cancelled = semaphore.acquire(controller.signal)
    controller.abort()
    await expect(cancelled).rejects.toThrow('cancelled')
    holder()
    semaphore.release()
    expect(fullJitterExponentialBackoff(0, { baseMs: 10, maxMs: 15, random: () => 0.5 })).toBe(5)
    expect(fullJitterExponentialBackoff(Number.NaN, { random: () => Number.POSITIVE_INFINITY })).toBe(0)
    expect(fullJitterExponentialBackoff(20, { random: () => { throw new Error('random') } })).toBe(0)

    const makeJob = (id: string): Job => ({
      id,
      documentId: baseTask.id,
      kind: 'parse',
      status: 'queued',
      progress: 0,
      dependsOnJobId: null,
      priority: 0,
      attempt: 1,
      maxAttempts: 2,
      payload: {},
      checkpoint: {},
      availableAt: now,
      leaseOwner: null,
      leaseExpiresAt: null,
      errorCode: null,
      errorMessage: null,
      startedAt: null,
      finishedAt: null,
      createdAt: now,
      updatedAt: now
    })
    const completed = makeJob('complete-job')
    let claimCount = 0
    const completedRepository = {
      recoverExpired: () => [],
      claimBatch: () => claimCount++ === 0 ? [{ ...completed, status: 'running' as const, leaseOwner: 'owner' }] : [],
      updateProgressAndCheckpoint: (input: { progress: number; checkpoint: Record<string, unknown> }) => ({ ...completed, status: 'running' as const, progress: input.progress, checkpoint: input.checkpoint }),
      complete: (input: { status: Job['status']; progress?: number; checkpoint?: Record<string, unknown> }) => ({ ...completed, status: input.status, progress: input.progress ?? 100, checkpoint: input.checkpoint ?? {} }),
      heartbeat: () => completed,
      failOrRetry: () => ({ ...completed, status: 'failed' as const }),
      cancel: () => completed,
      enqueue: () => completed,
      get: () => completed,
      list: () => [],
      manualRetry: () => completed,
      listEvents: () => []
    } as unknown as JobRepositoryPort
    const scheduler = new JobScheduler(completedRepository, {
      leaseOwner: 'quality-owner',
      parseAggregationWindowMs: 0,
      pollIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
      runners: {
        parse: {
          run: async ({ updateProgress }) => {
            await updateProgress(50, { stage: 'running' })
            return { status: 'succeeded', progress: 100, checkpoint: { stage: 'done' } }
          }
        }
      }
    })
    await scheduler.start()
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise))
    await scheduler.shutdown()
    expect(scheduler.getState()).toBe('stopped')

    const failed = makeJob('failed-job')
    const failedRepository = {
      ...completedRepository,
      claimBatch: () => [{ ...failed, status: 'running' as const, leaseOwner: 'owner' }],
      failOrRetry: () => ({ ...failed, status: 'failed' as const })
    } as unknown as JobRepositoryPort
    const failingScheduler = new JobScheduler(failedRepository, {
      leaseOwner: 'quality-owner',
      parseAggregationWindowMs: 0,
      pollIntervalMs: 60_000,
      runners: { parse: { run: async () => { throw new JobRunnerError('no retry', 'NO_RETRY', false) } } }
    })
    await failingScheduler.start()
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise))
    await failingScheduler.shutdown()
    expect(failingScheduler.getState()).toBe('stopped')
  })

  it('returns explicit parser runner failures for missing documents, auth, and submission', async () => {
    const job = {
      id: 'parse-quality',
      documentId: baseTask.id,
      kind: 'parse',
      status: 'queued',
      progress: 0,
      checkpoint: {}
    } as unknown as Job
    const input = {
      signal: new AbortController().signal,
      updateProgress: async () => job
    }
    const missingRunner = new ParseJobRunner({
      repository: { getTask: async () => null } as never,
      jobRepository: {} as never,
      settingsService: {} as never,
      vault: {} as never,
      parserClient: {} as never,
      compute: {} as never,
      pathPolicy: new PathPolicy()
    })
    await expect(missingRunner.runBatch({ jobs: [], ...input })).resolves.toEqual([])
    const missing = await missingRunner.runBatch({ jobs: [job], ...input })
    expect(missing[0]?.error).toMatchObject({ code: 'DOCUMENT_NOT_FOUND' })
    const authRunner = new ParseJobRunner({
      repository: { getTask: async () => baseTask } as never,
      jobRepository: {} as never,
      settingsService: { get: async () => baseSettings } as never,
      vault: { get: async () => null } as never,
      parserClient: {} as never,
      compute: {} as never,
      pathPolicy: new PathPolicy()
    })
    const auth = await authRunner.runBatch({ jobs: [job], ...input })
    expect(auth[0]?.error).toMatchObject({ code: 'PARSER_AUTH_REQUIRED' })
    const submitRunner = new ParseJobRunner({
      repository: { getTask: async () => baseTask } as never,
      jobRepository: {} as never,
      settingsService: { get: async () => baseSettings } as never,
      vault: { get: async () => 'token' } as never,
      parserClient: { createUploadBatch: async () => { throw new Error('network timeout') } } as never,
      compute: {} as never,
      pathPolicy: new PathPolicy()
    })
    const submitted = await submitRunner.runBatch({ jobs: [job], ...input })
    expect(submitted[0]?.error).toMatchObject({ code: 'PARSER_SUBMIT_FAILED', retryable: true })
  })
})
