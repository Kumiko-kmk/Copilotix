import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TaskComputePort } from '../src/core/ports'
import { PathPolicy } from '../src/main/pathPolicy'
import { TranslationCredentialError, TranslationHttpError, type TranslationProvider } from '../src/main/translation/providers'
import { TranslationPlanOrchestrator, withRetry } from '../src/main/translation/translationPlanOrchestrator'
import type {
  PlainTranslationRequest,
  TranslationPlanCounts,
  TranslationPlanMutationResult,
  TranslationPlanWorkDescriptor
} from '@shared/translationPlanProtocol'
import type { CopilotixTask, TranslationProviderId } from '@shared/types'

const TASK_ID = '11111111-1111-4111-8111-111111111111'
const JOB_ID = '22222222-2222-4222-8222-222222222222'
const PLAN_ID = '33333333-3333-4333-8333-333333333333'
const SOURCE_HASH = 'a'.repeat(64)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

interface Fixture {
  root: string
  task: CopilotixTask
  descriptor: TranslationPlanWorkDescriptor
  request: PlainTranslationRequest
  compute: FakeCompute
}

class FakeCompute {
  readonly cacheCalls: string[] = []
  readonly applyCalls: string[] = []
  readonly failCalls: string[] = []
  readonly progress: TranslationPlanCounts[] = []
  private status: TranslationPlanWorkDescriptor['status'] = 'pending'
  private readonly cacheHits: Set<string>
  applyFailureFor: TranslationProviderId | null = null

  constructor(private readonly descriptor: TranslationPlanWorkDescriptor, cacheHits: TranslationProviderId[] = []) {
    this.cacheHits = new Set(cacheHits)
  }

  asTaskCompute(): TaskComputePort {
    return {
      hashFile: async () => SOURCE_HASH,
      importPdf: async () => ({ sha256: SOURCE_HASH, size: 0 }),
      normalizeParserOutput: async () => ({ normalized: true, displayTitle: null, pageCount: 1 }),
      rebuildMappings: async () => undefined,
      openTranslationPlan: async () => this.resultCounts('open'),
      listTranslationWork: async () => ({
        items: [{ ...this.descriptor, status: this.status }],
        nextCursor: null,
        counts: this.counts()
      }),
      tryTranslationCache: async (_taskId, _jobId, _unitId, provider) => {
        this.cacheCalls.push(provider)
        if (this.cacheHits.has(provider)) this.status = 'completed'
        return this.mutation()
      },
      applyTranslation: async (_taskId, _jobId, _unitId, _responsePath, provider) => {
        this.applyCalls.push(provider ?? 'none')
        if (provider === this.applyFailureFor) throw new Error(`${provider} apply failed`)
        this.status = 'completed'
        return this.mutation()
      },
      failTranslation: async () => {
        this.failCalls.push(this.descriptor.unitId)
        this.status = 'failed'
        return this.mutation()
      },
      finalizeTranslation: async () => ({
        ...this.counts(),
        status: this.status === 'failed' ? 'partial' as const : 'succeeded' as const,
        failedBlockIdsSample: this.status === 'failed' ? [...this.descriptor.blockIds] : [],
        translatedRelativePath: 'full.zh-CN.md',
        manifestRelativePath: 'translation.manifest.json',
        checkpointRelativePath: 'translation.checkpoint.json',
        hashes: { translated: SOURCE_HASH, manifest: SOURCE_HASH, checkpoint: SOURCE_HASH }
      })
    }
  }

  private counts(): TranslationPlanCounts {
    return {
      total: 1,
      completed: this.status === 'completed' ? 1 : 0,
      failed: this.status === 'failed' ? 1 : 0
    }
  }

  private mutation(): TranslationPlanMutationResult {
    return { ...this.counts(), unitId: this.descriptor.unitId, status: this.status }
  }

  private resultCounts(_stage: string) {
    return { planId: PLAN_ID, taskId: TASK_ID, jobId: JOB_ID, sourceHash: SOURCE_HASH, reused: false, ...this.counts() }
  }
}

async function makeFixture(sourceText = 'Hello', cacheHits: TranslationProviderId[] = []): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'copilotix-plan-orchestrator-'))
  roots.push(root)
  const unitId = '44444444-4444-4444-8444-444444444444'
  const descriptor: TranslationPlanWorkDescriptor = {
    unitId,
    kind: 'plain',
    sourceHash: SOURCE_HASH,
    blockIds: ['translation-block-1'],
    requestPath: `.translation/${JOB_ID}/requests/${unitId}.json`,
    responsePath: `.translation/${JOB_ID}/responses/${unitId}.json`,
    resultPath: `.translation/${JOB_ID}/results/${unitId}.md`,
    status: 'pending'
  }
  const request: PlainTranslationRequest = {
    protocol: 'copilotix-translation-plain-v1',
    targetLanguage: 'zh-CN',
    unitId,
    sourceHash: SOURCE_HASH,
    segments: [{ id: `${unitId}-segment-0`, text: sourceText }]
  }
  await mkdir(join(root, '.translation', JOB_ID, 'requests'), { recursive: true })
  await writeFile(join(root, ...descriptor.requestPath.split('/')), `${JSON.stringify(request)}\n`, 'utf8')
  const task: CopilotixTask = {
    id: TASK_ID,
    originalName: 'paper.pdf',
    title: null,
    name: 'paper.pdf',
    sourcePath: join(root, 'original.pdf'),
    sourceHash: 'fixture-task-hash',
    outputDir: root,
    status: 'translating',
    progress: 0,
    translationProvider: 'qwen',
    remoteBatchId: null,
    remoteDataId: null,
    remoteResultUrl: null,
    error: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
  return { root, task, descriptor, request, compute: new FakeCompute(descriptor, cacheHits) }
}

function provider(
  id: TranslationProviderId,
  translate: (text: string, signal?: AbortSignal) => Promise<string>,
  counters: string[],
  available = true
): TranslationProvider {
  return {
    id,
    model: `${id}-fixture-model`,
    isAvailable: async () => available,
    translate: async (text, signal) => {
      counters.push(`${id}:${text.length}`)
      return translate(text, signal)
    },
    translateTable: async () => ({ protocol: 'copilotix-table-translation-v2', translations: [] })
  }
}

function run(
  fixture: Fixture,
  providers: Map<TranslationProviderId, TranslationProvider>,
  signal = new AbortController().signal,
  providerOrder: TranslationProviderId[] = ['qwen', 'deepseek', 'bing', 'transmart']
) {
  return new TranslationPlanOrchestrator({
    task: fixture.task,
    jobId: JOB_ID,
    providers,
    providerOrder,
    compute: fixture.compute.asTaskCompute(),
    pathPolicy: new PathPolicy(),
    signal,
    onProgress: async ({ counts }) => { fixture.compute.progress.push(counts) }
  }).run()
}

describe('translation plan orchestrator', () => {
  it('fails clearly without opening a plan when no enabled provider is executable', async () => {
    const fixture = await makeFixture('No verified provider')
    const calls: string[] = []
    const providers = new Map<TranslationProviderId, TranslationProvider>([
      ['qwen', provider('qwen', async (text) => `q:${text}`, calls)],
      ['deepseek', provider('deepseek', async (text) => `d:${text}`, calls)]
    ])

    await expect(run(fixture, providers, new AbortController().signal, [])).rejects.toThrow('没有可用的翻译服务')
    expect(calls).toEqual([])
    expect(fixture.compute.cacheCalls).toEqual([])
  })

  it('uses a utility cache hit without calling a provider', async () => {
    const fixture = await makeFixture('Cached text', ['qwen'])
    const calls: string[] = []
    const result = await run(fixture, new Map([['qwen', provider('qwen', async (text) => `译:${text}`, calls)]]))

    expect(result.status).toBe('succeeded')
    expect(fixture.compute.cacheCalls).toEqual(['qwen'])
    expect(calls).toEqual([])
    expect(fixture.compute.applyCalls).toEqual([])
    expect(fixture.compute.failCalls).toEqual([])
  })

  it('splits long plain segments into provider requests no longer than 4000', async () => {
    const fixture = await makeFixture('a'.repeat(9_001))
    const calls: string[] = []
    await run(fixture, new Map([['qwen', provider('qwen', async (text) => `译:${text}`, calls)]]))

    const lengths = calls.map((entry) => Number(entry.split(':')[1]))
    expect(lengths.length).toBeGreaterThan(1)
    expect(Math.max(...lengths)).toBeLessThanOrEqual(4_000)
    expect(lengths.reduce((sum, length) => sum + length, 0)).toBe(fixture.request.segments[0]!.text.length)
    const response = JSON.parse(await readFile(join(fixture.root, ...fixture.descriptor.responsePath.split('/')), 'utf8')) as { response: { translations: Array<{ text: string }> } }
    expect(response.response.translations[0]!.text).toHaveLength(9_001 + 2 * lengths.length)
  })

  it('consumes and releases each translation-plan page before requesting the next page', async () => {
    const fixture = await makeFixture('First page')
    const secondId = '55555555-5555-4555-8555-555555555555'
    const second: TranslationPlanWorkDescriptor = {
      ...fixture.descriptor,
      unitId: secondId,
      blockIds: ['translation-block-2'],
      requestPath: `.translation/${JOB_ID}/requests/${secondId}.json`,
      responsePath: `.translation/${JOB_ID}/responses/${secondId}.json`,
      resultPath: `.translation/${JOB_ID}/results/${secondId}.md`
    }
    await writeFile(join(fixture.root, ...second.requestPath.split('/')), `${JSON.stringify({
      ...fixture.request,
      unitId: secondId,
      segments: [{ id: `${secondId}-segment-0`, text: 'Second page' }]
    })}\n`, 'utf8')
    const events: string[] = []
    const completed = new Set<string>()
    const counts = (): TranslationPlanCounts => ({ total: 2, completed: completed.size, failed: 0 })
    const mutation = (unitId: string): TranslationPlanMutationResult => ({
      ...counts(),
      unitId,
      status: completed.has(unitId) ? 'completed' : 'pending'
    })
    const compute: TaskComputePort = {
      hashFile: async () => SOURCE_HASH,
      importPdf: async () => ({ sha256: SOURCE_HASH, size: 0 }),
      normalizeParserOutput: async () => ({ normalized: true, displayTitle: null, pageCount: 1 }),
      rebuildMappings: async () => undefined,
      openTranslationPlan: async () => ({ planId: PLAN_ID, taskId: TASK_ID, jobId: JOB_ID, sourceHash: SOURCE_HASH, reused: false, ...counts() }),
      listTranslationWork: async (_taskId, _jobId, cursor) => {
        events.push(`list:${cursor}`)
        const descriptor = cursor === 0 ? fixture.descriptor : second
        return { items: [descriptor], nextCursor: cursor === 0 ? 1 : null, counts: counts() }
      },
      tryTranslationCache: async (_taskId, _jobId, unitId) => mutation(unitId),
      applyTranslation: async (_taskId, _jobId, unitId) => {
        completed.add(unitId)
        events.push(`apply:${unitId}`)
        return mutation(unitId)
      },
      failTranslation: async (_taskId, _jobId, unitId) => mutation(unitId),
      finalizeTranslation: async () => ({
        ...counts(),
        status: 'succeeded',
        failedBlockIdsSample: [],
        translatedRelativePath: 'full.zh-CN.md',
        manifestRelativePath: 'translation.manifest.json',
        checkpointRelativePath: 'translation.checkpoint.json',
        hashes: { translated: SOURCE_HASH, manifest: SOURCE_HASH, checkpoint: SOURCE_HASH }
      })
    }
    const calls: string[] = []
    const providers = new Map<TranslationProviderId, TranslationProvider>([
      ['qwen', provider('qwen', async (text) => `译:${text}`, calls)]
    ])

    const result = await new TranslationPlanOrchestrator({
      task: fixture.task,
      jobId: JOB_ID,
      providers,
      providerOrder: ['qwen'],
      compute,
      pathPolicy: new PathPolicy(),
      signal: new AbortController().signal,
      onProgress: () => undefined
    }).run()

    expect(result.completed).toBe(2)
    expect(events.indexOf(`apply:${fixture.descriptor.unitId}`)).toBeLessThan(events.indexOf('list:1'))
    expect(calls).toHaveLength(2)
  })

  it('falls back after provider or utility apply failure', async () => {
    const fixture = await makeFixture('Fallback me')
    fixture.compute.applyFailureFor = 'qwen'
    const calls: string[] = []
    await run(fixture, new Map([
      ['qwen', provider('qwen', async (text) => `q:${text}`, calls)],
      ['deepseek', provider('deepseek', async (text) => `d:${text}`, calls)]
    ]))

    expect(fixture.compute.cacheCalls).toEqual(['qwen', 'deepseek'])
    expect(fixture.compute.applyCalls).toEqual(['qwen', 'deepseek'])
    expect(calls[0]).toMatch(/^qwen:/)
    expect(calls[1]).toMatch(/^deepseek:/)
    expect(fixture.compute.failCalls).toEqual([])
  })

  it('marks a unit failed after every provider fails', async () => {
    const fixture = await makeFixture('No provider can translate')
    const calls: string[] = []
    const providers = new Map<TranslationProviderId, TranslationProvider>([
      ['qwen', provider('qwen', async () => { throw new TranslationHttpError('qwen down', 500, 0) }, calls)],
      ['deepseek', provider('deepseek', async () => { throw new TranslationHttpError('deepseek down', 500, 0) }, calls)]
    ])
    const result = await run(fixture, providers)

    expect(result.status).toBe('partial')
    expect(fixture.compute.failCalls).toEqual([fixture.descriptor.unitId])
    expect(calls).toHaveLength(6)
    expect(calls.slice(0, 3).every((entry) => entry.startsWith('qwen:'))).toBe(true)
    expect(calls.slice(3).every((entry) => entry.startsWith('deepseek:'))).toBe(true)
  })

  it('does not retry a provider after an authentication failure', async () => {
    const fixture = await makeFixture('Bad credentials')
    let calls = 0
    const provider: TranslationProvider = {
      id: 'qwen',
      model: 'qwen-fixture-model',
      credentialName: 'qwen',
      isAvailable: async () => true,
      translate: async () => {
        calls += 1
        throw new TranslationHttpError('invalid key', 401)
      },
      translateTable: async () => {
        throw new TranslationCredentialError('invalid key', 'qwen')
      }
    }

    const result = await run(fixture, new Map([['qwen', provider]]))
    expect(result.status).toBe('partial')
    expect(calls).toBe(1)
    expect(fixture.compute.failCalls).toEqual([fixture.descriptor.unitId])
  })

  it('retries request AbortError when the job itself was not cancelled', async () => {
    vi.useFakeTimers()
    try {
      const error = new Error('transport aborted')
      error.name = 'AbortError'
      const operation = vi.fn().mockRejectedValueOnce(error).mockResolvedValue('translated')
      const result = withRetry(operation, new AbortController().signal)
      await vi.runAllTimersAsync()
      await expect(result).resolves.toBe('translated')
      expect(operation).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops without failing the unit when the signal is aborted', async () => {
    const fixture = await makeFixture('Abort me')
    const controller = new AbortController()
    let receivedSignal: AbortSignal | undefined
    const providers = new Map<TranslationProviderId, TranslationProvider>([
      ['qwen', provider('qwen', async (text, signal) => {
        receivedSignal = signal
        await new Promise<string>((_resolve, reject) => {
          if (!signal) {
            reject(new Error('job signal missing'))
            return
          }
          const timer = setTimeout(() => controller.abort(), 10)
          signal.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(new Error('provider observed abort'))
          }, { once: true })
        })
        return `译:${text}`
      }, [])]
    ])

    await expect(run(fixture, providers, controller.signal)).rejects.toThrow(/aborted/i)
    expect(receivedSignal).toBe(controller.signal)
    expect(fixture.compute.failCalls).toEqual([])
  })
})
