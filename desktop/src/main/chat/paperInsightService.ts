import { z } from 'zod'
import { paperBriefContentSchema } from '@shared/paperBrief/schema'
import type { ModelGateway } from './modelGateway'
import { assembleBrief, buildBriefMessages, buildBriefRepairMessage, clipPreviousAnswer, parseBriefResponse, PAPER_BRIEF_REQUEST, PAPER_BRIEF_MAX_REQUEST_BYTES, type PaperBrief } from '@shared/paperBrief'
import type { BriefContextResult, BriefAnchor } from '@shared/paperBrief/contracts'
import { paperInsightStateSchema, paperInsightRequestSchema, type PaperInsightState } from '@shared/paperInsight'
import { hasPaperChatConsent, resolvePaperChatModel, resolvePaperChatProvider, type PaperChatProvider } from '@shared/paperChatSchemas'
import type { AppSettings } from '@shared/types'
import type { Job } from '@core/types'
import { ChatProviderError } from './chatProvider'
import type { ProviderTokenUsage } from '../usageAnalyticsService'

export interface PaperInsightDependencies {
  settings(): Promise<AppSettings>
  key(provider: PaperChatProvider): Promise<string | null>
  get(documentId: string): Promise<PaperInsightState>
  context(documentId: string, signal: AbortSignal): Promise<BriefContextResult>
  save(documentId: string, brief: PaperBrief, anchors: BriefAnchor[]): Promise<unknown>
  stream: ModelGateway['stream']
  recordUsage(provider: PaperChatProvider, usage: ProviderTokenUsage): Promise<void>
  changed(documentId: string, state: PaperInsightState): void
  canStart(): boolean
}
type Run = { documentId: string; automatic: boolean; controller: AbortController; done: Promise<void>; finish(): void }

/** One queued/running generation per document; at most two active pipelines globally. */
export class PaperInsightService {
  private readonly runs = new Map<string, Run>()
  private readonly queue: Run[] = []
  private readonly failures = new Map<string, PaperInsightState>()
  private readonly blocked = new Set<string>()
  private active = 0
  private paused = false
  private destroyed = false
  constructor(private readonly deps: PaperInsightDependencies) {}

  private emit(documentId: string, state: PaperInsightState): void {
    const valid = paperInsightStateSchema.parse(state)
    if (valid.status === 'failed') {
      this.failures.set(documentId, valid)
      if (this.failures.size > 256) this.failures.delete(this.failures.keys().next().value!)
    } else this.failures.delete(documentId)
    try { this.deps.changed(documentId, valid) } catch { /* A closed renderer must not interrupt durable generation. */ }
  }

  private async authorization() {
    const settings = await this.deps.settings()
    const provider = resolvePaperChatProvider(settings)
    if (!provider) return { reason: '请在设置中将已启用的 Qwen、DeepSeek 或 Codex 设为首选服务商。' } as const
    if (!hasPaperChatConsent(settings, provider)) return { reason: '请先在阅读器 AI 问答中同意向服务商发送论文片段。' } as const
    const key = provider === 'codex' ? null : await this.deps.key(provider)
    if (provider !== 'codex' && !key) return { reason: '请先在服务连接中保存模型 API Key。' } as const
    if (provider !== 'codex' && settings.credentials[provider].state !== 'valid') return { reason: '请先在服务连接中验证模型 API Key。' } as const
    const model = resolvePaperChatModel(provider, provider === 'codex' ? settings.codex?.chatModel : provider === 'qwen' ? settings.qwenChatModel : settings.deepseekChatModel)
    return { settings, provider, key, model } as const
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

  private pump(): void {
    while (this.active < 2 && this.queue.length) {
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
    const timer = setTimeout(() => controller.abort(new Error('timeout')), 300_000)
    try {
      signal.throwIfAborted()
      const stored = await this.deps.get(documentId)
      signal.throwIfAborted()
      if (run.automatic && stored.status === 'ready' && !stored.stale) { this.emit(documentId, stored); return }
      let auth = await this.authorization()
      signal.throwIfAborted()
      if (auth.reason !== undefined) { this.emit(documentId, { status: 'unavailable', reason: auth.reason }); return }
      const context = await this.deps.context(documentId, signal)
      if (context.documentId !== documentId) throw new Error('scope mismatch')
      const messages = buildBriefMessages(context.context)
      for (let attempt = 0; attempt < 2; attempt++) {
        // Recheck credentials, consent and configuration after queue/context work and before retries.
        auth = await this.authorization()
        signal.throwIfAborted()
        if (auth.reason !== undefined) { this.emit(documentId, { status: 'unavailable', reason: auth.reason }); return }
        let answer = ''
        const usage = await this.deps.stream({
          provider: auth.provider, model: auth.model, key: auth.key,
          baseUrl: auth.provider === 'qwen' ? auth.settings.qwenBaseUrl : auth.settings.deepseekBaseUrl,
          signal, messages, ...(auth.provider === 'codex' ? { outputSchema: z.toJSONSchema(paperBriefContentSchema) } : {}), ...PAPER_BRIEF_REQUEST, maxRequestBytes: PAPER_BRIEF_MAX_REQUEST_BYTES,
          onDelta: (delta) => {
            signal.throwIfAborted()
            if (answer.length + delta.length > 32_768) throw new Error('output budget exceeded')
            answer += delta
          }
        })
        if (usage) await this.deps.recordUsage(auth.provider, usage).catch(() => undefined)
        signal.throwIfAborted()
        const parsed = parseBriefResponse(answer, { lengths: attempt === 0 })
        if (!parsed.ok) {
          if (attempt === 0) {
            messages.push({ role: 'assistant', content: clipPreviousAnswer(answer) }, buildBriefRepairMessage(parsed.problems))
            continue
          }
          throw new Error('invalid structured response')
        }
        const brief = assembleBrief(parsed.content, context.context, {
          provider: auth.provider, model: auth.model, sourceRevision: context.sourceRevision
        })
        const cited = new Set(brief.findings.flatMap((finding) => finding.anchors))
        const anchors = context.context.excerpts.filter((excerpt) => cited.has(excerpt.id)).map(({ id, section, text }) => ({ id, section, text }))
        signal.throwIfAborted()
        // Await atomic write even when cancellation arrives during commit, then report actual disk state.
        await this.deps.save(documentId, brief, anchors)
        this.emit(documentId, await this.deps.get(documentId))
        return
      }
    } catch (error) {
      if (signal.aborted) {
        const stored = await this.deps.get(documentId).catch((): PaperInsightState => ({ status: 'missing' }))
        this.emit(documentId, stored.status === 'ready' ? stored : { status: 'failed', error: '生成已取消或超时，可重新生成。' })
      } else {
        // Never persist or forward provider bodies, prompts, paths or API keys in errors.
        this.emit(documentId, { status: 'failed', error: error instanceof ChatProviderError && error.code === 'EMBEDDING_RATE_LIMITED'
          ? '服务商限流，请稍后重试。' : '生成或保存 AI 解读失败，请检查模型服务与论文内容后重试。' })
      }
    } finally { clearTimeout(timer) }
  }

  cancel(documentId: string): { cancelled: boolean } {
    const run = this.runs.get(documentId)
    run?.controller.abort()
    return { cancelled: !!run }
  }
  cancelAll(): void { for (const run of this.runs.values()) run.controller.abort() }
  async pause(): Promise<void> {
    this.paused = true
    this.cancelAll()
    await Promise.all([...this.runs.values()].map((run) => run.done))
  }
  resume(): void { if (!this.destroyed) this.paused = false }
  async dispose(): Promise<void> { this.destroyed = true; await this.pause() }
  async deleteDocument<T>(documentId: string, remove: () => Promise<T>): Promise<T> {
    if (this.blocked.has(documentId)) throw new Error('论文正在删除')
    this.blocked.add(documentId)
    try {
      const run = this.runs.get(documentId)
      run?.controller.abort()
      await run?.done
      return await remove()
    } finally { this.blocked.delete(documentId); this.failures.delete(documentId) }
  }
  async onJobChanged(job: Pick<Job, 'kind' | 'status' | 'documentId'>): Promise<void> {
    if (!['translate', 'parse'].includes(job.kind) || job.status !== 'succeeded' || !this.deps.canStart() || this.paused || this.destroyed) return
    // Every completed translation queues its brief; consent and a verified key are still checked before sending.
    if (job.kind === 'translate') await this.generate(job.documentId, true)
    else this.emit(job.documentId, await this.get(job.documentId))
  }
}
