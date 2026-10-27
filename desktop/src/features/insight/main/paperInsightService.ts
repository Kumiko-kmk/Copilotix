import { z } from 'zod'
import { lstat, open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { buildFullBriefContext, PaperBriefInputError } from '../core/paperBrief/context'
import { briefSourceSchema, briefContextResultSchema, type BriefSource } from '../core/paperBrief/contracts'
import { paperBriefModelOutputSchema } from '../core/paperBrief/schema'
import type { ModelGateway } from '@features/chat/main'
import { assembleBrief, buildBriefMessages, buildBriefRepairMessage, clipPreviousAnswer, parseBriefResponse, PAPER_BRIEF_REQUEST, PAPER_BRIEF_MAX_REQUEST_BYTES, type PaperBrief } from '../core/paperBrief'
import type { BriefContextResult, BriefAnchor } from '../core/paperBrief/contracts'
import { paperInsightStateSchema, paperInsightRequestSchema, type PaperInsightState } from '../contract/paperInsight'
import { resolvePaperChatModel, resolvePaperChatProvider, type PaperChatProvider } from '@features/chat/contract/paperChatSchemas'
import type { AppSettings } from '@features/settings/contract/settingsTypes'
import type { Job } from '@platform/jobs/core/jobs'
import { ChatProviderError, abortable } from '@features/chat/main'
import type { ProviderTokenUsage } from '@features/settings/main'
import { CodexGenerationError, codexFailure } from '@platform/codex/runtime/codexRuntime'
import { archiveInsightListRequestSchema, type ArchiveInsightSnapshot } from '../contract/archiveInsight'

export async function loadFullBriefContext(documentId: string, signal: AbortSignal,
  source: () => Promise<BriefSource>): Promise<BriefContextResult> {
  signal.throwIfAborted()
  const descriptor = briefSourceSchema.parse(await source())
  if (descriptor.documentId !== documentId) throw new PaperBriefInputError('论文来源不匹配')
  for (const artifact of descriptor.sources) {
    signal.throwIfAborted()
    const info = await lstat(artifact.path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) throw new PaperBriefInputError('论文全文来源无效或超过 16 MiB；未截断内容')
    const handle = await open(artifact.path, 'r')
    let data: Buffer
    try {
      if ((await handle.stat()).size > 16 * 1024 * 1024) throw new PaperBriefInputError('论文全文超过 16 MiB；未截断内容')
      data = await handle.readFile({ signal })
    } finally { await handle.close() }
    if (createHash('sha256').update(data).digest('hex') !== artifact.hash) throw new PaperBriefInputError('论文内容正在更新，请重试')
    const markdown = data.toString('utf8')
    if (!markdown.trim()) continue
    signal.throwIfAborted()
    const after = briefSourceSchema.parse(await source())
    if (after.documentId !== documentId || after.sourceRevision !== descriptor.sourceRevision || JSON.stringify(after.sources) !== JSON.stringify(descriptor.sources)) throw new PaperBriefInputError('论文内容正在更新，请重试')
    return briefContextResultSchema.parse({ documentId, sourceRevision: descriptor.sourceRevision,
      context: buildFullBriefContext(artifact.language === 'original' ? markdown : '', artifact.language === 'translated' ? markdown : '') })
  }
  throw new PaperBriefInputError('论文正文为空')
}

export interface PaperInsightDependencies {
  settings(): Promise<AppSettings>
  key(provider: PaperChatProvider): Promise<string | null>
  get(documentId: string): Promise<PaperInsightState>
  listSaved?(documentIds: readonly string[]): Promise<ArchiveInsightSnapshot[]>
  context(documentId: string, signal: AbortSignal): Promise<BriefContextResult>
  save(documentId: string, brief: PaperBrief, anchors: BriefAnchor[]): Promise<unknown>
  stream: ModelGateway['stream']
  recordUsage(provider: PaperChatProvider, usage: ProviderTokenUsage): Promise<void>
  changed(documentId: string, state: PaperInsightState): void
  canStart(): boolean
  /** Local descriptor check for startup recovery; never reads/uploads paper text. */
  hasText?(documentId: string): Promise<boolean>
  /** Receives only classified, log-safe failure details; never prompts, paper text or keys. */
  log?(details: Record<string, unknown>): void
}
type Run = { documentId: string; automatic: boolean; controller: AbortController; done: Promise<void>; finish(): void }

const PAPER_INSIGHT_CONCURRENCY = 8

/** One queued/running generation per document; bounded network work only. */
export class PaperInsightService {
  private readonly runs = new Map<string, Run>()
  private readonly queue: Run[] = []
  private readonly failures = new Map<string, PaperInsightState>()
  private readonly blocked = new Set<string>()
  private active = 0
  private paused = false
  private destroyed = false
  private recovery?: { controller: AbortController; done: Promise<void> }
  constructor(private readonly deps: PaperInsightDependencies) {}

  private emit(documentId: string, state: PaperInsightState): void {
    const valid = paperInsightStateSchema.parse(state)
    if (valid.status === 'failed') {
      this.failures.set(documentId, valid)
      if (this.failures.size > 256) this.failures.delete(this.failures.keys().next().value!)
    } else this.failures.delete(documentId)
    try { this.deps.changed(documentId, valid) } catch { /* A closed renderer must not interrupt durable generation. */ }
  }

  private async authorization(selected?: PaperChatProvider) {
    const settings = await this.deps.settings()
    const provider = resolvePaperChatProvider(settings, selected)
    if (!provider) return { reason: '请在设置中将已启用的 Qwen、DeepSeek 或 Codex 设为首选服务商。' } as const
    const key = provider === 'codex' ? null : await this.deps.key(provider)
    if (provider !== 'codex' && !key) return { reason: '请先在服务连接中保存模型 API Key。' } as const
    if (provider !== 'codex' && settings.credentials[provider].state !== 'valid') return { reason: '请先在服务连接中验证模型 API Key。' } as const
    const model = resolvePaperChatModel(provider, provider === 'codex' ? settings.codex?.chatModel : provider === 'qwen' ? settings.qwenChatModel : settings.deepseekChatModel)
    return { settings, provider, key, model } as const
  }

  /** Next enabled Qwen/DeepSeek in the translation order with a saved, valid key; used after Codex exhausts its retries. */
  private async fallbackProvider(): Promise<PaperChatProvider | undefined> {
    for (const id of (await this.deps.settings()).translationProviderOrder) {
      if ((id === 'qwen' || id === 'deepseek') && (await this.authorization(id)).reason === undefined) return id
    }
    return undefined
  }

  list(documentIds: readonly string[]): Promise<ArchiveInsightSnapshot[]> {
    const request = archiveInsightListRequestSchema.parse({ documentIds })
    return this.deps.listSaved?.(request.documentIds) ?? Promise.resolve([])
  }

  async getSaved(documentId: string): Promise<PaperInsightState> {
    paperInsightRequestSchema.parse({ documentId })
    try { return paperInsightStateSchema.parse(await this.deps.get(documentId)) }
    catch { return { status: 'failed', error: '无法读取本地解读，请检查论文目录后重试。' } }
  }

  async get(documentId: string): Promise<PaperInsightState> {
    paperInsightRequestSchema.parse({ documentId })
    if (this.runs.has(documentId)) return { status: 'generating' }
    try {
      const stored = await this.deps.get(documentId)
      if (stored.status === 'ready') return stored
      const auth = await this.authorization()
      if (auth.reason !== undefined) return { status: 'unavailable', reason: auth.reason }
      return this.failures.get(documentId) ?? stored
    } catch { return { status: 'failed', error: '无法读取本地解读，请检查论文目录后重试。' } }
  }

  async generate(documentId: string, automatic = false): Promise<void> {
    paperInsightRequestSchema.parse({ documentId })
    if (this.runs.has(documentId)) return
    if (this.destroyed || this.paused || this.blocked.has(documentId) || !this.deps.canStart()) throw new Error('文库正在维护或退出，请稍后再试。')
    if (this.runs.size >= 200) throw new Error('待生成解读过多，请稍后重试。')
    let finish!: () => void
    const run: Run = { documentId, automatic, controller: new AbortController(), done: new Promise<void>((resolve) => { finish = resolve }), finish: () => finish() }
    this.runs.set(documentId, run)
    this.queue.push(run)
    this.emit(documentId, { status: 'generating' })
    this.pump()
  }

  /** Resume only missing cards after a restart; ready/stale cards remain untouched. */
  recover(documentIds: readonly string[]): Promise<void> {
    if (this.recovery) return this.recovery.done
    const controller = new AbortController(), signal = controller.signal
    const recovery = { controller, done: Promise.resolve() }
    recovery.done = (async () => {
      const hasText = this.deps.hasText
      if (!hasText) return
      for (const documentId of new Set(documentIds)) {
        if (signal.aborted || this.destroyed || this.paused || !this.deps.canStart()) return
        if (this.runs.has(documentId)) continue
        const stored = await abortable(this.deps.get(documentId), signal).catch(() => null)
        if (stored?.status !== 'missing' || !await abortable(hasText(documentId), signal).catch(() => false)) continue
        // Keep only IDs pending locally; full contexts are loaded by active runs.
        while (this.runs.size >= 200) {
          await abortable(Promise.race([...this.runs.values()].map(run => run.done)), signal)
        }
        if (signal.aborted || this.destroyed || this.paused || !this.deps.canStart()) return
        if (this.blocked.has(documentId)) continue
        await this.generate(documentId, true)
      }
    })().finally(() => { if (this.recovery === recovery) this.recovery = undefined })
    this.recovery = recovery
    return recovery.done
  }

  private pump(): void {
    while (!this.paused && !this.destroyed && this.active < PAPER_INSIGHT_CONCURRENCY && this.queue.length) {
      const run = this.queue.shift()!
      this.active++
      void this.execute(run).finally(() => {
        this.runs.delete(run.documentId)
        this.active--
        run.finish()
        this.pump()
      })
    }
  }

  private async execute(run: Run): Promise<void> {
    const { documentId, controller } = run
    const signal = controller.signal
    // The detailed brief streams up to ~6000 output tokens; allow for slow provider periods.
    const timer = setTimeout(() => controller.abort(new Error('timeout')), 600_000)
    const started = Date.now()
    let stage = 'prepare', provider: PaperChatProvider | undefined, attempts = 0
    let problems: string[] | undefined
    try {
      signal.throwIfAborted()
      const stored = await this.deps.get(documentId)
      signal.throwIfAborted()
      if (run.automatic && stored.status === 'ready' && !stored.stale) { this.emit(documentId, stored); return }
      let auth = await this.authorization()
      signal.throwIfAborted()
      if (auth.reason !== undefined) { this.emit(documentId, { status: 'unavailable', reason: auth.reason }); return }
      stage = 'context'
      const context = await this.deps.context(documentId, signal)
      if (context.documentId !== documentId) throw new Error('scope mismatch')
      const messages = buildBriefMessages(context.context)
      let selected: PaperChatProvider | undefined
      // The fallback provider starts from a clean prompt with its own repair attempt.
      const switchTo = (next: PaperChatProvider, category: string): void => {
        this.deps.log?.({ documentId, status: 'fallback', from: 'codex', to: next, category, ...(problems ? { problems } : {}) })
        selected = next
        messages.splice(0, messages.length, ...buildBriefMessages(context.context))
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        // Recheck credentials and configuration after queue/context work and before retries.
        auth = await this.authorization(selected)
        signal.throwIfAborted()
        if (auth.reason !== undefined) { this.emit(documentId, { status: 'unavailable', reason: auth.reason }); return }
        stage = 'generate'; provider = auth.provider; attempts = attempt + 1
        const streamAuth = auth
        let answer = ''
        let usage: Awaited<ReturnType<PaperInsightDependencies['stream']>>
        try { usage = await withBriefTransportRetry(() => {
          answer = ''
          return this.deps.stream({
          provider: streamAuth.provider, model: streamAuth.model, key: streamAuth.key,
          baseUrl: streamAuth.provider === 'qwen' ? streamAuth.settings.qwenBaseUrl : streamAuth.settings.deepseekBaseUrl,
          signal, messages, lane: 'background', firstByteMs: 120_000, ...(streamAuth.provider === 'codex' ? { effort: 'medium' as const, outputSchema: z.toJSONSchema(paperBriefModelOutputSchema) } : {}), ...PAPER_BRIEF_REQUEST, maxRequestBytes: PAPER_BRIEF_MAX_REQUEST_BYTES,
          onDelta: (delta) => {
            signal.throwIfAborted()
            if (answer.length + delta.length > 32_768) throw new Error('output budget exceeded')
            answer += delta
          }
          })
        }, auth.provider, signal) } catch (error) {
          // Codex already backed off and retried; an oversized paper would not fit a smaller model either.
          const next = auth.provider === 'codex' && !signal.aborted && !(error instanceof CodexGenerationError && error.code === 'RAG_LIMIT_EXCEEDED') &&
            (error instanceof CodexGenerationError || codexFailure(error).retryable) ? await this.fallbackProvider() : undefined
          if (!next) throw error
          switchTo(next, failureCategory(error)); attempt = -1
          continue
        }
        if (usage) await this.deps.recordUsage(auth.provider, usage).catch(() => undefined)
        signal.throwIfAborted()
        stage = 'parse'
        const parsed = parseBriefResponse(answer, { lengths: attempt === 0, requireAnalysis: true })
        if (!parsed.ok) {
          problems = problemFields(parsed.problems)
          if (attempt === 0) {
            messages.push({ role: 'assistant', content: clipPreviousAnswer(answer) }, buildBriefRepairMessage(parsed.problems))
            continue
          }
          // The strict length contract can defeat one model; another enabled provider gets a full try.
          const next = auth.provider === 'codex' && !signal.aborted ? await this.fallbackProvider() : undefined
          if (!next) throw new Error('invalid structured response')
          switchTo(next, 'invalid-structured-response'); attempt = -1
          continue
        }
        const brief = assembleBrief(parsed.content, context.context, {
          provider: auth.provider, model: auth.model, sourceRevision: context.sourceRevision
        })
        const cited = new Set([...brief.findings.flatMap((finding) => finding.anchors),
          ...Object.values(brief.metadata ?? {}).flatMap(fact => fact?.anchors ?? [])])
        const anchors = context.context.excerpts.filter((excerpt) => cited.has(excerpt.id)).map(({ id, section, text }) => ({ id, section, text }))
        signal.throwIfAborted()
        // Await atomic write even when cancellation arrives during commit, then report actual disk state.
        stage = 'save'
        await this.deps.save(documentId, brief, anchors)
        this.emit(documentId, await this.deps.get(documentId))
        return
      }
    } catch (error) {
      const reason: unknown = signal.reason
      this.deps.log?.({ documentId, status: signal.aborted ? 'cancelled' : 'failed', stage, provider, attempts, durationMs: Date.now() - started,
        category: signal.aborted ? (reason instanceof Error && reason.message === 'timeout' ? 'timeout' : 'cancelled') : failureCategory(error),
        ...(stage === 'parse' && problems ? { problems } : {}) })
      if (signal.aborted) {
        const stored = await this.deps.get(documentId).catch((): PaperInsightState => ({ status: 'missing' }))
        this.emit(documentId, stored.status === 'ready' ? stored : { status: 'failed', error: '生成已取消或超时，可重新生成。' })
      } else {
        // Never persist or forward provider bodies, prompts, paths or API keys in errors.
        this.emit(documentId, { status: 'failed', error: error instanceof PaperBriefInputError ? error.message
          : error instanceof Error && 'code' in error && error.code === 'RAG_LIMIT_EXCEEDED'
            ? '论文全文超过所选模型或请求容量；未截断内容，请选择更大上下文的模型。'
            : error instanceof Error && 'code' in error && error.code === 'EMBEDDING_RATE_LIMITED'
              ? '服务商限流，请稍后重试。'
              // Codex messages are fixed application text, never provider bodies.
              : error instanceof CodexGenerationError ? error.message : '生成或保存 AI 解读失败，请检查模型服务与论文内容后重试。' })
      }
    } finally { clearTimeout(timer) }
  }

  cancel(documentId: string): { cancelled: boolean } {
    const run = this.runs.get(documentId)
    if (!run) return { cancelled: false }
    run.controller.abort()
    const queued = this.queue.indexOf(run)
    if (queued >= 0) {
      this.queue.splice(queued, 1)
      this.runs.delete(documentId)
      this.emit(documentId, { status: 'failed', error: '生成已取消，可重新生成。' })
      run.finish()
    }
    return { cancelled: true }
  }
  cancelAll(): void {
    this.recovery?.controller.abort()
    for (const run of [...this.runs.values()]) this.cancel(run.documentId)
  }
  async pause(): Promise<void> {
    this.paused = true
    const recovery = this.recovery
    this.cancelAll()
    await Promise.all([...this.runs.values()].map((run) => run.done).concat(recovery ? [recovery.done.catch(() => undefined)] : []))
  }
  resume(): void { if (!this.destroyed) { this.paused = false; this.pump() } }
  async dispose(): Promise<void> { this.destroyed = true; await this.pause() }
  async deleteDocument<T>(documentId: string, remove: () => Promise<T>): Promise<T> {
    if (this.blocked.has(documentId)) throw new Error('论文正在删除')
    this.blocked.add(documentId)
    try {
      const run = this.runs.get(documentId)
      this.cancel(documentId)
      await run?.done
      return await remove()
    } finally { this.blocked.delete(documentId); this.failures.delete(documentId) }
  }
  async onJobChanged(job: Pick<Job, 'kind' | 'status' | 'documentId'>): Promise<void> {
    if (!['translate', 'parse'].includes(job.kind) || job.status !== 'succeeded' || !this.deps.canStart() || this.paused || this.destroyed) return
    // Full original text is ready after parsing: analysis overlaps translation.
    // The translation event also recovers older imports and failed generation.
    if (job.kind === 'parse' || job.kind === 'translate') await this.generate(job.documentId, true)
    else this.emit(job.documentId, await this.get(job.documentId))
  }
}

/** Network retries are bounded separately from the one structured-output repair. */
async function withBriefTransportRetry<T>(operation: () => Promise<T>, provider: PaperChatProvider, signal: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted()
    try { return await operation() } catch (error) {
      // Codex already owns its account-wide adaptive retry policy.
      if (provider === 'codex' || signal.aborted || attempt >= 2 || !(error instanceof ChatProviderError)
        || !['EMBEDDING_RATE_LIMITED', 'RAG_TIMEOUT', 'PROVIDER_UNAVAILABLE'].includes(error.code)) throw error
      const delayMs = error.retryAfterMs ?? 1_000 * 2 ** attempt
      if (delayMs > 60_000) throw error
      await sleep(delayMs, undefined, { signal })
    }
  }
}

/** Field paths and display lengths from parser hints (e.g. "analysis.abstract:178"); never generated text. */
function problemFields(problems: readonly string[]): string[] {
  return problems.slice(0, 12).map((problem) => {
    const [path = '', detail = ''] = problem.split('：', 2)
    const field = /^[\w.]{1,80}$/u.test(path) ? path : 'other'
    const length = /^(\d+) (?:字|项)/u.exec(detail)?.[1]
    return length ? `${field}:${length}` : field
  })
}

/** Log-safe failure label: error classes and fixed internal messages only. */
function failureCategory(error: unknown): string {
  if (error instanceof CodexGenerationError) return `codex:${error.category}`
  if (error instanceof ChatProviderError) return `provider:${error.code}`
  if (error instanceof PaperBriefInputError) return 'input'
  const message = error instanceof Error ? error.message : ''
  if (message === 'invalid structured response') return 'invalid-structured-response'
  if (message === 'output budget exceeded') return 'output-budget'
  if (message === 'scope mismatch') return 'scope-mismatch'
  return codexFailure(error).category
}
