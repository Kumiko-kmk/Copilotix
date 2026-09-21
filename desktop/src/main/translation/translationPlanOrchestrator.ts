import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import PQueue from 'p-queue'
import type { TranslationPlanFinalizeResult, TranslationPlanCounts, TranslationPlanMutationResult, TranslationPlanRequest, TranslationPlanResponse, TranslationPlanWorkDescriptor, PlainTranslationResponse, TableTranslationResponse } from '@shared/translationPlanProtocol'
import {
  plainTranslationRequestSchema,
  plainTranslationResponseSchema,
  tableTranslationRequestSchema,
  tableTranslationResponseSchema,
  translationPlanFinalizeResultSchema,
  translationPlanListResultSchema,
  translationPlanMutationResultSchema,
  translationPlanOpenResultSchema,
  translationPlanResponseEnvelopeSchema,
  validateTableTranslationResponse
} from '@shared/translationPlanProtocol'
import type { CredentialName, CopilotixTask, TranslationProviderId } from '@shared/types'
import type { PathPolicyPort, TaskComputePort } from '@core/ports'
import type { ArtifactService } from '../artifactService'
import type { TranslationProvider } from './providers'
import { TranslationCredentialError, TranslationHttpError } from './providers'
import { PathPolicy } from '../pathPolicy'

const MAX_TRANSLATION_SEGMENT_LENGTH = 4_000
const MAX_TRANSLATION_PLAN_PAGE = 32
const MAX_RETRY_ATTEMPTS = 3

/** The only file operation the orchestrator needs from ArtifactService. */
export interface TranslationPlanFileWriter {
  atomicWriteFile(path: string, content: string): Promise<void>
}

export interface TranslationPlanProgress {
  counts: TranslationPlanCounts
  failedBlockIds: readonly string[]
}

export interface TranslationPlanOrchestratorOptions {
  task: CopilotixTask
  jobId: string
  providers: Map<TranslationProviderId, TranslationProvider>
  providerOrder: readonly TranslationProviderId[]
  compute: TaskComputePort
  /** ArtifactService is accepted by structural typing; a small writer keeps tests lightweight. */
  artifacts?: TranslationPlanFileWriter | Pick<ArtifactService, 'atomicWriteFile'>
  /** Alias useful to callers that name the dependency after the concrete service. */
  artifactService?: TranslationPlanFileWriter | Pick<ArtifactService, 'atomicWriteFile'>
  pathPolicy?: PathPolicyPort
  signal: AbortSignal
  onProgress(progress: TranslationPlanProgress): void | Promise<void>
  onCredentialFailure?(name: CredentialName): void | Promise<void>
}

/**
 * Main-side coordinator for a utility-owned translation plan.  It only reads
 * and writes bounded JSON files and sends plan metadata through TaskComputePort;
 * Markdown parsing and persistence remain in the utility process.
 */
export class TranslationPlanOrchestrator {
  private readonly pathPolicy: PathPolicyPort
  private readonly fileWriter: TranslationPlanFileWriter | undefined
  private progressTail = Promise.resolve()
  private readonly failedBlockIds = new Set<string>()
  /**
   * Authentication failures disable that credential for the remainder of the
   * current translation run.  Without this guard, every pending unit could
   * independently retry the same known-bad key before the settings cache is
   * refreshed.
   */
  private readonly disabledCredentials = new Set<CredentialName>()

  constructor(private readonly options: TranslationPlanOrchestratorOptions) {
    this.pathPolicy = options.pathPolicy ?? new PathPolicy()
    this.fileWriter = options.artifacts ?? options.artifactService
  }

  async run(): Promise<TranslationPlanFinalizeResult> {
    const { task, jobId, signal } = this.options
    throwIfAborted(signal)
    if (this.options.providerOrder.length === 0) throw new Error('没有可用的翻译服务')
    const compute = requirePlanCompute(this.options.compute)
    const opened = translationPlanOpenResultSchema.parse(await compute.openTranslationPlan(task.id, jobId, signal))
    throwIfAborted(signal)
    await this.report(opened, [])

    let cursor = 0
    for (;;) {
      throwIfAborted(signal)
      const page = translationPlanListResultSchema.parse(
        await compute.listTranslationWork(task.id, jobId, cursor, MAX_TRANSLATION_PLAN_PAGE, signal)
      )
      throwIfAborted(signal)
      this.rememberFailed(page.items)
      await this.report(page.counts, [])
      const pending = page.items.filter((item) => item.status === 'pending')
      if (pending.length > 0) await this.processPage(pending, compute)
      if (page.nextCursor === null) break
      if (page.nextCursor <= cursor) throw new Error('翻译计划分页 cursor 未前进')
      cursor = page.nextCursor
    }

    throwIfAborted(signal)

    const finalized = translationPlanFinalizeResultSchema.parse(
      await compute.finalizeTranslation(task.id, jobId, signal)
    )
    throwIfAborted(signal)
    this.rememberFailedIds(finalized.failedBlockIdsSample)
    await this.report(finalized, [])
    return finalized
  }

  private async processPage(
    descriptors: readonly TranslationPlanWorkDescriptor[],
    compute: PlanComputePort
  ): Promise<void> {
    const queue = new PQueue({ concurrency: 3 })
    const tasks = descriptors.map((descriptor) => queue.add(() => this.processUnit(descriptor, compute)))
    const settled = await Promise.allSettled(tasks)
    await queue.onIdle()
    const rejected = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (rejected) throw rejected.reason
  }

  private async processUnit(
    descriptor: TranslationPlanWorkDescriptor,
    compute: PlanComputePort
  ): Promise<void> {
    const { task, jobId, providers, signal } = this.options
    throwIfAborted(signal)
    const errors: string[] = []
    const request = lazyRequest(() => this.readRequest(descriptor))
    for (const providerId of this.options.providerOrder) {
      throwIfAborted(signal)
      const provider = providers.get(providerId)
      if (!provider) continue
      if (provider.credentialName && this.disabledCredentials.has(provider.credentialName)) continue

      let available = false
      try {
        available = await provider.isAvailable()
        throwIfAborted(signal)
      } catch (error) {
        if (isAbortError(error, signal)) throw abortError()
        errors.push(`${providerId}: ${readableError(error)}`)
        continue
      }
      if (!available) continue

      let cache: TranslationPlanMutationResult
      try {
        cache = translationPlanMutationResultSchema.parse(
          await compute.tryTranslationCache(task.id, jobId, descriptor.unitId, provider.id, provider.model, signal)
        )
        throwIfAborted(signal)
        this.rememberMutation(descriptor, cache)
        await this.report(cache, [])
        if (cache.status === 'completed') return
      } catch (error) {
        if (isAbortError(error, signal)) throw abortError()
        errors.push(`${providerId} 缓存: ${readableError(error)}`)
        continue
      }

      try {
        const parsedRequest = await request()
        throwIfAborted(signal)
        const response = await translateRequest(parsedRequest, provider, signal)
        throwIfAborted(signal)
        const envelope = translationPlanResponseEnvelopeSchema.parse({
          protocol: 'copilotix-translation-response-v1',
          unitId: descriptor.unitId,
          kind: descriptor.kind,
          sourceHash: descriptor.sourceHash,
          response
        })
        await this.writeResponse(descriptor.responsePath, envelope)
        throwIfAborted(signal)
        const applied = translationPlanMutationResultSchema.parse(
          await compute.applyTranslation(
            task.id,
            jobId,
            descriptor.unitId,
            descriptor.responsePath,
            provider.id,
            provider.model,
            signal
          )
        )
        throwIfAborted(signal)
        this.rememberMutation(descriptor, applied)
        await this.report(applied, [])
        if (applied.status === 'completed') return
        throw new Error(`utility 未完成翻译单元（状态：${applied.status}）`)
      } catch (error) {
        if (isAbortError(error, signal)) throw abortError()
        const credentialName = credentialFailureFor(provider, error)
        if (credentialName) {
          this.disabledCredentials.add(credentialName)
          await this.options.onCredentialFailure?.(credentialName)
        }
        errors.push(`${providerId}: ${readableError(error)}`)
      }
    }

    throwIfAborted(signal)
    const message = (errors.length > 0 ? errors.join('；') : '没有可用的翻译源').slice(0, 32_768)
    const failed = translationPlanMutationResultSchema.parse(
      await compute.failTranslation(task.id, jobId, descriptor.unitId, message, signal)
    )
    throwIfAborted(signal)
    this.rememberMutation(descriptor, failed)
    await this.report(failed, [])
  }

  private async readRequest(descriptor: TranslationPlanWorkDescriptor): Promise<TranslationPlanRequest> {
    throwIfAborted(this.options.signal)
    const absolutePath = this.resolvePlanPath(descriptor.requestPath)
    let raw: string
    try {
      raw = await readFile(absolutePath, 'utf8')
    } catch (error) {
      throw new Error(`无法读取翻译请求文件：${readableError(error)}`)
    }
    throwIfAborted(this.options.signal)
    let value: unknown
    try {
      value = JSON.parse(raw) as unknown
    } catch {
      throw new Error('翻译请求文件不是有效 JSON')
    }
    if (descriptor.kind === 'plain') {
      const request = plainTranslationRequestSchema.parse(value)
      if (request.unitId !== descriptor.unitId || request.sourceHash !== descriptor.sourceHash) {
        throw new Error('普通翻译请求与计划不匹配')
      }
      return request
    }
    return tableTranslationRequestSchema.parse(value)
  }

  private async writeResponse(responsePath: string, envelope: unknown): Promise<void> {
    throwIfAborted(this.options.signal)
    const path = this.resolvePlanPath(responsePath)
    const content = `${JSON.stringify(translationPlanResponseEnvelopeSchema.parse(envelope), null, 2)}\n`
    if (this.fileWriter) {
      await this.fileWriter.atomicWriteFile(path, content)
      return
    }
    await atomicWrite(path, content)
  }

  private resolvePlanPath(relativePath: string): string {
    if (!relativePath.startsWith('.translation/') || relativePath.includes('\\') || relativePath.split('/').some((part) => part === '..' || part.length === 0)) {
      throw new Error('翻译计划路径无效')
    }
    return this.pathPolicy.resolveChild(this.options.task.outputDir, relativePath)
  }

  private rememberFailed(items: readonly TranslationPlanWorkDescriptor[]): void {
    for (const item of items) if (item.status === 'failed') this.rememberFailedIds(item.blockIds)
  }

  private rememberFailedIds(blockIds: readonly string[]): void {
    for (const blockId of blockIds) this.failedBlockIds.add(blockId)
  }

  private rememberMutation(descriptor: TranslationPlanWorkDescriptor, result: TranslationPlanMutationResult): void {
    if (result.status === 'failed') this.rememberFailedIds(descriptor.blockIds)
    if (result.status !== 'failed') {
      for (const blockId of descriptor.blockIds) this.failedBlockIds.delete(blockId)
    }
  }

  private report(result: TranslationPlanCounts | TranslationPlanMutationResult | TranslationPlanFinalizeResult, _failedBlockIds: readonly string[]): Promise<void> {
    const operation = this.progressTail.then(() => this.options.onProgress({
      counts: { total: result.total, completed: result.completed, failed: result.failed },
      failedBlockIds: [...this.failedBlockIds].slice(0, 64)
    }))
    this.progressTail = operation.catch(() => undefined)
    return operation
  }
}

/** Function form for callers that do not need to retain an orchestrator instance. */
export async function runTranslationPlan(options: TranslationPlanOrchestratorOptions): Promise<TranslationPlanFinalizeResult> {
  return new TranslationPlanOrchestrator(options).run()
}

/** Alias kept explicit for call sites that describe this operation as orchestration. */
export const orchestrateTranslationPlan = runTranslationPlan

type PlanComputePort = Required<Pick<
  TaskComputePort,
  'openTranslationPlan' | 'listTranslationWork' | 'tryTranslationCache' | 'applyTranslation' | 'failTranslation' | 'finalizeTranslation'
>>

function requirePlanCompute(compute: TaskComputePort): PlanComputePort {
  if (!compute.openTranslationPlan || !compute.listTranslationWork || !compute.tryTranslationCache || !compute.applyTranslation || !compute.failTranslation || !compute.finalizeTranslation) {
    throw new Error('翻译计划计算接口尚未初始化')
  }
  return compute as PlanComputePort
}

async function translateRequest(
  request: TranslationPlanRequest,
  provider: TranslationProvider,
  signal: AbortSignal
): Promise<TranslationPlanResponse> {
  throwIfAborted(signal)
  if (request.protocol === 'copilotix-translation-plain-v1') {
    const translations: Array<{ id: string; text: string }> = []
    for (const segment of request.segments) {
      throwIfAborted(signal)
      const text = await translateLongText(segment.text, provider, signal)
      throwIfAborted(signal)
      translations.push({ id: segment.id, text })
    }
    return plainTranslationResponseSchema.parse({
      protocol: 'copilotix-translation-plain-v1',
      unitId: request.unitId,
      sourceHash: request.sourceHash,
      translations
    }) as PlainTranslationResponse
  }

  const translated = tableTranslationResponseSchema.parse(
    await withRetry(() => provider.translateTable(request, signal), signal)
  ) as TableTranslationResponse
  throwIfAborted(signal)
  return validateTableTranslationResponse(translated, request)
}

async function translateLongText(text: string, provider: TranslationProvider, signal: AbortSignal): Promise<string> {
  const parts = splitText(text, MAX_TRANSLATION_SEGMENT_LENGTH)
  const translated: string[] = []
  for (const part of parts) {
    throwIfAborted(signal)
    translated.push(await withRetry(() => provider.translate(part, signal), signal))
  }
  return translated.join('')
}

/** Split provider-facing text while guaranteeing every request is <= 4000 chars. */
export function splitText(text: string, limit = MAX_TRANSLATION_SEGMENT_LENGTH): string[] {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('翻译文本分段长度无效')
  const parts: string[] = []
  let remaining = text
  while (remaining.length > limit) {
    const slice = remaining.slice(0, limit)
    const boundary = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('。'), slice.lastIndexOf('; '), slice.lastIndexOf(' '))
    const end = boundary > limit / 2 ? boundary + 1 : limit
    parts.push(remaining.slice(0, end))
    remaining = remaining.slice(end)
  }
  if (remaining) parts.push(remaining)
  return parts
}

export async function withRetry<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt += 1) {
    throwIfAborted(signal)
    try {
      const value = await operation()
      throwIfAborted(signal)
      return value
    } catch (error) {
      if (isAbortError(error, signal)) throw abortError()
      lastError = error
      if (!isRetryableTranslationError(error)) throw error
      if (attempt === MAX_RETRY_ATTEMPTS - 1) break
      const retryAfter = error instanceof TranslationHttpError ? error.retryAfterMs : undefined
      await delay(retryAfter ?? 1_000 * 2 ** attempt, signal)
    }
  }
  throw lastError
}

function credentialFailureFor(provider: TranslationProvider, error: unknown): CredentialName | undefined {
  if (!provider.credentialName) return undefined
  if (error instanceof TranslationCredentialError) return error.credentialName
  if (error instanceof TranslationHttpError && (error.status === 401 || error.status === 403)) return provider.credentialName
  return undefined
}

function isRetryableTranslationError(error: unknown): boolean {
  if (error instanceof TranslationCredentialError) return false
  if (error instanceof TranslationHttpError) return error.status === 408 || error.status === 429 || error.status >= 500
  if (!error || typeof error !== 'object') return false
  const status = (error as { status?: unknown }).status
  if (typeof status === 'number') return status === 408 || status === 429 || status >= 500
  const message = error instanceof Error ? error.message : ''
  return /(?:timeout|timed out|timedout|network|fetch failed|failed to fetch|econn|socket|temporar|不可达|超时)/iu.test(message)
}

function lazyRequest(loader: () => Promise<TranslationPlanRequest>): () => Promise<TranslationPlanRequest> {
  let loaded: Promise<TranslationPlanRequest> | undefined
  return () => {
    loaded ??= loader()
    return loaded
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.partial-${randomUUID()}`
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' })
    const handle = await open(temporary, 'r+')
    try { await handle.sync() } finally { await handle.close() }
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  if (milliseconds <= 0) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError()
}

function abortError(): Error {
  const error = new Error('Job runner aborted')
  error.name = 'AbortError'
  return error
}

function isAbortError(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === 'AbortError')
}

function readableError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
