import type { ProviderKey } from '@platform/models/contract/models'
import type { ModelGateway } from '@features/chat/main'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { FIGURE_INSIGHT_MAX_REQUEST_BYTES, figureInsightContentSchema, figureInsightRequestSchema, figureInsightUploadSchema,
  archiveCoverSourceRequestSchema, figureInsightModelSchema, resolveFigureInsightModel, type ArchiveCoverSource, type FigureInsightDescriptor, type FigureInsightRequest,
  type FigureInsightSave, type FigureInsightState } from '../contract/figureInsight'
import { buildFigureInsightMessages } from '../core/figureInsightPrompt'
import { resolvePaperChatProvider, type PaperChatProvider } from '@features/chat/contract/paperChatSchemas'
import type { AppSettings } from '@features/settings/contract/settingsTypes'
import { abortable } from '@features/chat/main'
import type { ProviderTokenUsage } from '@features/settings/main'

export interface FigureInsightDependencies {
  settings(): Promise<AppSettings>
  keys(provider: PaperChatProvider): Promise<readonly ProviderKey[]>
  descriptor(request: FigureInsightRequest, signal: AbortSignal): Promise<FigureInsightDescriptor>
  get(request: FigureInsightRequest): Promise<FigureInsightState>
  coverSource?(documentId: string): Promise<ArchiveCoverSource>
  save(request: FigureInsightSave): Promise<unknown>
  stream: ModelGateway['stream']
  recordUsage(provider: PaperChatProvider, usage: ProviderTokenUsage): Promise<void>
  canStart(): boolean
  changed(request: FigureInsightRequest, state: FigureInsightState): void
  readImage?(descriptor: FigureInsightDescriptor): Promise<Buffer>
  encodeImage?(png: Buffer): Promise<{ bytes: Buffer; mimeType: 'image/png' | 'image/jpeg'; jpegQuality?: 98 }>
}
type Run = { request: FigureInsightRequest; controller: AbortController; done: Promise<void>; finish(): void }
class FigureAuthorizationError extends Error {}
const identity = (r: FigureInsightRequest): string => JSON.stringify([r.documentId, r.figureId])

/** Explicit per-image generation; no automatic upload or alteration of the text brief. */
export class FigureInsightService {
  private readonly runs = new Map<string, Run>()
  private readonly failures = new Map<string, FigureInsightState>()
  private readonly queue: Run[] = []
  private readonly blocked = new Set<string>()
  private active = 0
  private paused = false
  private destroyed = false
  constructor(private readonly deps: FigureInsightDependencies) {}

  async coverSource(documentId: string): Promise<ArchiveCoverSource> {
    archiveCoverSourceRequestSchema.parse({ documentId })
    if (!this.deps.coverSource) return Promise.reject(new Error('本地封面來源暫不可用。'))
    try { return await this.deps.coverSource(documentId) }
    catch { throw new Error('無法讀取本地封面來源，請檢查論文影象清單後重試。') }
  }

  private emit(request: FigureInsightRequest, state: FigureInsightState): void {
    const key = identity(request)
    if (state.status === 'failed' || state.status === 'unavailable') {
      this.failures.set(key, state)
      if (this.failures.size > 256) this.failures.delete(this.failures.keys().next().value!)
    } else this.failures.delete(key)
    try { this.deps.changed(request, state) } catch { /* Disk state does not depend on a window. */ }
  }

  async get(raw: FigureInsightRequest): Promise<FigureInsightState> {
    const request = figureInsightRequestSchema.parse(raw)
    if (this.runs.has(identity(request))) return { status: 'generating' }
    try {
      const stored = await this.deps.get(request)
      return stored.status === 'ready' ? stored : this.failures.get(identity(request)) ?? stored
    } catch { return { status: 'failed', error: '無法讀取圖片解讀，請檢查來源後重試。' } }
  }

  async generate(raw: FigureInsightRequest): Promise<void> {
    const request = figureInsightRequestSchema.parse(raw), key = identity(request)
    if (this.runs.has(key)) return
    if (this.destroyed || this.paused || this.blocked.has(request.documentId) || !this.deps.canStart()) throw new Error('文庫正在維護或退出，請稍後重試。')
    if (this.runs.size >= 100) throw new Error('待生成圖片過多，請稍後重試。')
    let finish!: () => void
    const run: Run = { request, controller: new AbortController(), done: new Promise<void>(resolve => { finish = resolve }), finish: () => finish() }
    this.runs.set(key, run); this.queue.push(run)
    this.emit(request, { status: 'generating' }); this.pump()
  }

  private pump(): void {
    while (!this.paused && !this.destroyed && this.active < 2 && this.queue.length) {
      const run = this.queue.shift()!
      this.active++
      void this.execute(run).finally(() => {
        this.runs.delete(identity(run.request)); this.active--; run.finish(); this.pump()
      })
    }
  }

  private async authorize() {
    const settings = await this.deps.settings(), provider = resolvePaperChatProvider(settings)
    if (!provider) throw new FigureAuthorizationError('請啟用 Qwen、DeepSeek 或 Codex 服務。')
    const keys = provider === 'codex' ? [] : await this.deps.keys(provider)
    if (provider !== 'codex' && (!keys.length || settings.credentials[provider].state !== 'valid')) throw new FigureAuthorizationError('請先儲存並驗證模型 API Key。')
    const name = resolveFigureInsightModel(provider, provider === 'codex' ? settings.codex?.chatModel ?? 'default' : provider === 'qwen' ? settings.qwenChatModel : settings.deepseekChatModel)
    const model = figureInsightModelSchema.parse({ provider, name })
    return { settings, provider, keys, model }
  }

  private async execute(run: Run): Promise<void> {
    const { request, controller } = run, signal = controller.signal
    const timer = setTimeout(() => controller.abort(), 300_000)
    try {
      signal.throwIfAborted()
      // Authorization is checked before touching/uploading paper context.
      try { await this.authorize() } catch (error) {
        this.emit(request, { status: 'unavailable', reason: error instanceof FigureAuthorizationError ? error.message : '模型服務不可用。' }); return
      }
      const descriptor = await abortable(this.deps.descriptor(request, signal), signal)
      if (descriptor.documentId !== request.documentId || descriptor.figureId !== request.figureId || descriptor.figure.figureId !== request.figureId) throw new Error('scope mismatch')
      const readImage = this.deps.readImage ?? (async (source: FigureInsightDescriptor) => {
        const info = await lstat(source.imagePath)
        if (!info.isFile() || info.isSymbolicLink() || info.size !== source.imageBytes) throw new Error('image changed')
        return readFile(source.imagePath)
      })
      const png = await abortable(readImage(descriptor), signal)
      if (png.length !== descriptor.imageBytes || createHash('sha256').update(png).digest('hex') !== descriptor.figure.pngSha256) throw new Error('image changed')
      const encoded = this.deps.encodeImage ? await abortable(this.deps.encodeImage(png), signal) : { bytes: png, mimeType: 'image/png' as const }
      const upload = figureInsightUploadSchema.parse({ mimeType: encoded.mimeType, byteLength: encoded.bytes.length,
        sha256: createHash('sha256').update(encoded.bytes).digest('hex'), ...('jpegQuality' in encoded && encoded.jpegQuality ? { jpegQuality: encoded.jpegQuality } : {}) })
      if (encoded.mimeType === 'image/jpeg' ? encoded.bytes.subarray(0, 3).toString('hex') !== 'ffd8ff' : encoded.bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('invalid encoded image')
      const messages = buildFigureInsightMessages(descriptor, encoded.bytes, encoded.mimeType)
      for (let attempt = 0; attempt < 2; attempt++) {
        const auth = await this.authorize()
        signal.throwIfAborted()
        let answer = ''
        const usage = await this.deps.stream({ provider: auth.provider, model: auth.model.name, keys: auth.keys,
          baseUrl: auth.provider === 'qwen' ? auth.settings.qwenBaseUrl : auth.settings.deepseekBaseUrl,
          messages, signal, purpose: 'figure', lane: 'background', ...(auth.provider === 'codex' ? { outputSchema: z.toJSONSchema(figureInsightContentSchema) } : {}), temperature: 0.2, maxOutputTokens: 1400, responseFormat: { type: 'json_object' },
          maxRequestBytes: FIGURE_INSIGHT_MAX_REQUEST_BYTES,
          firstByteMs: 120_000,
          onDelta: delta => { signal.throwIfAborted(); if (answer.length + delta.length > 8192) throw new Error('output too large'); answer += delta }
        })
        if (usage) await this.deps.recordUsage(auth.provider, usage).catch(() => undefined)
        signal.throwIfAborted()
        let value: unknown
        try { value = JSON.parse(answer) } catch { value = null }
        const content = figureInsightContentSchema.safeParse(value)
        if (!content.success) {
          if (attempt === 0) {
            messages.push({ role: 'assistant', content: answer.slice(0, 2048) },
              { role: 'user', content: `返回未透過校驗：${JSON.stringify(content.error.issues.map(issue => ({ field: issue.path.join('.'), error: issue.message })))}。請只返回displayWeight（0–100整數）、overview（目標100–160字元、硬上限240）、takeaway（目標50–90字元、硬上限160）。英文、空格及標點也逐個計數，改用簡短中文，不羅列英文標籤。純公式圖兩個文字欄位為空且評分0。非零評分文字不能為空。不要新增欄位或Markdown圍欄。` })
            continue
          }
          throw new Error('invalid output')
        }
        // Utility revalidates image and text revisions before committing. Await a started commit even on cancellation.
        await this.deps.save({ ...request, sourceRevision: descriptor.sourceRevision, content: content.data, model: auth.model, upload })
        this.emit(request, await this.deps.get(request)); return
      }
    } catch {
      this.emit(request, { status: 'failed', error: signal.aborted ? '圖片解讀已取消或超時，可重新生成。' : '圖片解讀失敗，請檢查整圖來源與模型服務後重試。' })
    } finally { clearTimeout(timer) }
  }

  cancel(request: FigureInsightRequest): { cancelled: boolean } {
    const run = this.runs.get(identity(figureInsightRequestSchema.parse(request)))
    if (!run) return { cancelled: false }
    run.controller.abort()
    const queued = this.queue.indexOf(run)
    if (queued >= 0) {
      this.queue.splice(queued, 1); this.runs.delete(identity(run.request))
      this.emit(run.request, { status: 'failed', error: '圖片解讀已取消，可重新生成。' }); run.finish()
    }
    return { cancelled: true }
  }
  cancelAll(): void { for (const run of [...this.runs.values()]) this.cancel(run.request) }
  async settleDocument(documentId: string): Promise<void> {
    const runs = [...this.runs.values()].filter(run => run.request.documentId === documentId)
    runs.forEach(run => this.cancel(run.request)); await Promise.all(runs.map(run => run.done))
  }
  async deleteDocument<T>(documentId: string, remove: () => Promise<T>): Promise<T> {
    this.blocked.add(documentId)
    try { await this.settleDocument(documentId); return await remove() } finally { this.blocked.delete(documentId) }
  }
  async pause(): Promise<void> {
    this.paused = true
    this.cancelAll()
    await Promise.all([...this.runs.values()].map(run => run.done))
  }
  resume(): void { if (!this.destroyed) { this.paused = false; this.pump() } }
  async dispose(): Promise<void> { this.destroyed = true; await this.pause() }
}
