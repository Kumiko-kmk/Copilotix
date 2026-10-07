import { DEFAULT_SETTINGS } from '@shared/constants'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
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
import { RpcRagContentIndexer } from '@main/rpcRagContentIndexer'
import { RpcRagRepository } from '@main/rpcRagRepository'
import { COMPUTE_RPC_TIMEOUT_MS, RpcTaskCompute } from '@main/rpcTaskCompute'
import { RpcTaskRepository } from '@main/rpcTaskRepository'
import { SettingsService } from '@main/settingsService'
import { canTransition, JobRunnerError } from '@core/jobs'
import { BLOCK_MAPPING_VERSION } from '@core/blockMapping'
import type { TaskComputePort } from '@core/ports'
import type { Job } from '@core/types'
import type { JobRepositoryPort } from '@core/jobs'
import type { AppSettings, DocumentPayload, CopilotixTask } from '@shared/types'
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
const baseTask: CopilotixTask = {
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

const baseSettings: AppSettings = {
  ...DEFAULT_SETTINGS,
  outputRoot: 'C:\\output',
  formulaEnabled: true,
  tableEnabled: true,
  translationProvider: 'qwen',
  translationProviderOrder: ['qwen', 'deepseek', 'bing', 'transmart'],
  enabledTranslationProviders: ['qwen', 'deepseek', 'bing', 'transmart'],
  qwenBaseUrl: 'https://qwen.example.test',
  qwenModel: 'qwen-model',
  deepseekBaseUrl: 'https://deepseek.example.test',
  deepseekModel: 'deepseek-model',
  credentials: {
    parser: { state: 'missing' as const },
    qwen: { state: 'missing' as const },
    deepseek: { state: 'missing' as const }
  }
}

const roots: string[] = []

afterEach(async () => {
  keyring.values.clear()
  keyring.failures.clear()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('main quality boundaries', () => {
  it('sanitizes JSON line logs and keeps append failures non-fatal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilotix-quality-logger-'))
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
    keyring.failures.add('Copilotix Desktop:deepseek-api-key')
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
        if (operation === 'compute:rag-content-index') return {
          documentId: 'task', contentRevisionId: 'revision', chunkCount: 3, revisionState: 'ready'
        }
        if (operation === 'tasks:get' || operation === 'documents:get-summary' || operation === 'knowledge:get') return null
        if (operation === 'knowledge:set-semantic-consent') return {
          documentId: 'task', localState: 'unindexed', localProgress: 0, localError: null,
          activeContentRevisionId: null, semanticConsent: true, semanticState: 'requires-credential',
          semanticProgress: 0, semanticError: null, semanticContentRevisionId: null,
          activeVectorIndexId: null, semanticProfileId: null, updatedAt: now
        }
        if (operation === 'knowledge:ensure-embed') return {
          documentId: 'task', profileId: 'profile', contentRevisionId: 'revision',
          vectorIndexId: 'vector-index', jobId: 'embed-job', jobKind: 'rag-embed',
          jobStatus: 'queued', vectorIndexState: 'queued', semanticState: 'queued'
        }
        if (operation === 'jobs:list' || operation === 'jobs:claim-batch' || operation === 'jobs:recover-expired') return []
        if (operation === 'tasks:list' || operation === 'documents:list') {
          // Two pages: the repository must follow the cursor to the end.
          return (payload as { after?: unknown }).after ? { items: [], next: null } : { items: [], next: { createdAt: now, id: 'task' } }
        }
        return undefined
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
    await repository.listDocumentAnnotations({ documentId: 'task', view: 'original' })
    await repository.mutateDocumentAnnotations({ documentId: 'task', artifactId: 'artifact', view: 'original', expectedRevision: 0, upserts: [], deleteIds: [] })
    await repository.insertTasks([baseTask])
    await repository.updateDocumentMetadata('task', { displayTitle: 'title' })
    await repository.deleteTask('task')
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

    const rag = new RpcRagRepository(supervisor)
    await expect(rag.getKnowledge('task')).resolves.toBeNull()
    await rag.setSemanticConsent('task', true, now)
    await rag.ensureEmbeddingJob('task', 'profile', now)

    const contentIndexer = new RpcRagContentIndexer(supervisor)
    const indexSignal = new AbortController().signal
    await expect(contentIndexer.index('task', 'revision', indexSignal)).resolves.toMatchObject({ chunkCount: 3 })

    expect(calls.some((call) => call.operation === 'compute:translation-plan-open' && call.payload === 'full.md')).toBe(false)
    expect(calls.filter((call) => call.operation === 'documents:list').map((call) => call.payload)).toEqual([{}, { after: { createdAt: now, id: 'task' } }])
    expect(calls.map((call) => call.operation)).toContain('jobs:cancel')
    expect(calls).toContainEqual({ operation: 'knowledge:get', payload: { documentId: 'task' }, options: undefined })
    expect(calls).toContainEqual({
      operation: 'knowledge:set-semantic-consent',
      payload: { documentId: 'task', consent: true, now },
      options: undefined
    })
    expect(calls).toContainEqual({
      operation: 'knowledge:ensure-embed',
      payload: { documentId: 'task', profileId: 'profile', now },
      options: undefined
    })
    expect(calls).toContainEqual({
      operation: 'compute:rag-content-index',
      payload: { documentId: 'task', contentRevisionId: 'revision' },
      options: { signal: indexSignal, timeoutMs: COMPUTE_RPC_TIMEOUT_MS }
    })
  })

  it('loads and atomically writes bounded artifact projections', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilotix-quality-artifacts-'))
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

    expect(await service.resolveAsset(task.id, '/images/figure.png')).toBe(join(await realpath(root), 'images', 'figure.png'))
    await service.atomicWriteFile(join(root, 'atomic.json'), JSON.stringify({ ok: true }))
    await expect(readFile(join(root, 'atomic.json'), 'utf8')).resolves.toContain('"ok":true')

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
      pdfUrl: 'copilotix-asset://task/original.pdf',
      assetBaseUrl: 'copilotix-asset://task/'
    }
    expect(projectDocumentDetails(payload).summary.id).toBe(baseTask.id)
    expect(canTransition(null, 'queued')).toBe(true)
    expect(canTransition('running', 'queued')).toBe(false)
    expect(canTransition('running', 'queued', false, true)).toBe(true)
    expect(canTransition('failed', 'queued', true)).toBe(true)
    expect(canTransition('failed', 'queued')).toBe(false)
    expect(new JobRunnerError('failed', 'TEST', true)).toMatchObject({ code: 'TEST', retryable: true })
  })

  it('validates credentials independently, masks stored values, and supports explicit clear', async () => {
    const saved: unknown[] = []
    let repositorySettings = { ...baseSettings, credentials: { ...baseSettings.credentials } }
    const repository = {
      getSettings: async () => repositorySettings,
      saveSettings: async (value: AppSettings) => { saved.push(value); repositorySettings = value }
    } as unknown as TaskRepositoryCompat
    const values = new Map<CredentialAccount, string>([['parser-token', 'parser']])
    const vault: CredentialVault = {
      get: async (account) => values.get(account) ?? null,
      set: async (account, value) => { values.set(account, value) },
      delete: async (account) => { values.delete(account) },
      has: async (account) => values.has(account)
    }
    const service = new SettingsService(repository, vault, 'C:\\default-output', {
      parser: async (value) => ({ ok: value === 'parser-next', message: 'Token 验证成功' }),
      provider: async (name, value) => ({ ok: value === name, message: `${name} 验证成功` })
    })
    await expect(service.get()).resolves.toMatchObject({ credentials: { parser: { state: 'unknown', maskedValue: 'pa****er' }, qwen: { state: 'missing' } } })
    const result = await service.save({
      ...DEFAULT_SETTINGS,
      credentialMutations: {
        parser: { action: 'set', value: ' parser-next ' },
        qwen: { action: 'clear' },
        deepseek: { action: 'set', value: 'deepseek' }
      },
      outputRoot: 'C:\\new-output',
      formulaEnabled: true,
      tableEnabled: false,
      translationProvider: 'deepseek',
      translationProviderOrder: ['deepseek', 'qwen', 'bing', 'transmart'],
      enabledTranslationProviders: ['deepseek', 'qwen', 'bing', 'transmart'],
      qwenBaseUrl: 'https://qwen.example.test',
      qwenModel: 'qwen',
      deepseekBaseUrl: 'https://deepseek.example.test',
      deepseekModel: 'deepseek'
    })
    expect(values.get('parser-token')).toBe('parser-next')
    expect(values.get('deepseek-api-key')).toBe('deepseek')
    expect(result.fieldErrors).toEqual({})
    expect(result.settings.credentials.parser).toMatchObject({ state: 'valid', maskedValue: 'parse****-next' })
    expect(result.settings.credentials.deepseek).toMatchObject({ state: 'valid', maskedValue: 'de****ek' })
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ formulaEnabled: true, tableEnabled: true })
  })

  it('exercises document commands across duplicate, retry, import, and deletion paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilotix-quality-commands-'))
    roots.push(root)
    const source = join(root, 'paper.pdf')
    const duplicateSource = join(root, 'duplicate.pdf')
    const textFile = join(root, 'notes.txt')
    await writeFile(source, '%PDF-1.4 source')
    await writeFile(duplicateSource, '%PDF-1.4 duplicate')
    await writeFile(textFile, 'not a PDF')

    const settings = {
      ...baseSettings,
      outputRoot: join(root, 'output'),
      credentials: {
        parser: { state: 'valid' as const },
        qwen: { state: 'missing' as const },
        deepseek: { state: 'missing' as const }
      }
    }
    const tasks = new Map<string, CopilotixTask>()
    const enqueued: unknown[] = []
    const insertBatches: number[] = []
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
      insertTasks: async (created: CopilotixTask[]) => {
        insertBatches.push(created.length)
        for (const task of created) tasks.set(task.id, task)
      },
      getTask: async (id: string) => id === baseTask.id ? { ...baseTask, outputDir: join(root, 'output', 'documents-v2', baseTask.id) } : tasks.get(id) ?? null,
      updateTask: async (id: string, patch: Partial<CopilotixTask>) => ({ ...baseTask, id, ...patch }),
      deleteTask: async (id: string) => { tasks.delete(id) }
    } as unknown as TaskRepositoryCompat
    const compute = {
      hashFile: async (path: string) => path === duplicateSource ? 'existing-hash' : 'new-hash',
      importPdf: async (path: string, id: string) => {
        if (path.endsWith('oversized.pdf')) throw Object.assign(new Error('PDF exceeds the supported size limit'), { code: 'CORE_LIMIT_EXCEEDED' })
        return { sha256: path.includes('bulk-') ? `hash-${path}` : 'imported-hash', size: 12 + id.length }
      }
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
    const first = await service.importPaths([duplicateSource, join(root, 'oversized.pdf'), duplicateSource, textFile], {})
    expect(first.created).toHaveLength(1)
    // One bad file is reported without aborting the rest of the selection.
    expect(first.failed).toEqual([{ name: 'oversized.pdf', message: '超过 200MB 或 600 页的解析限制' }])
    expect(scheduler.wake).toHaveBeenCalled()
    // A selection larger than one RPC batch is inserted in bounded batches.
    const bulk = Array.from({ length: 205 }, (_, index) => join(root, `bulk-${index}.pdf`))
    expect((await service.importPaths(bulk, {})).created).toHaveLength(205)
    expect(insertBatches).toEqual([1, 100, 100, 5])
    // Parse jobs are created with the documents; import never enqueues separately.
    expect(enqueued).toEqual([])
    await expect(service.retry(baseTask.id)).resolves.toBeUndefined()
    expect(enqueued).toHaveLength(1)
    await expect(service.retry('missing')).rejects.toThrow('任务不存在')
    const noRetryJobs = { ...jobs, list: async () => [] } as unknown as JobRepositoryPort
    const noRetryService = new DocumentCommandService(repository, { get: async () => settings } as never, compute, new PathPolicy(), logger, { jobRepository: noRetryJobs })
    await expect(noRetryService.retry(baseTask.id)).rejects.toThrow('不可重试')
    await expect(service.delete(baseTask.id, false)).resolves.toBeUndefined()
    await expect(service.delete('missing', true)).resolves.toBeUndefined()

    const noTokenService = new DocumentCommandService(
      repository,
      { get: async () => ({ ...settings, credentials: { ...settings.credentials, parser: { state: 'missing' as const } } }) } as never,
      compute,
      new PathPolicy(),
      logger
    )
    await expect(noTokenService.importPaths([source], {})).rejects.toThrow('Token')
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
