import { z } from 'zod'
import { DEFAULT_SETTINGS } from '@shared/constants'
import type { PaperChatProvider } from '@shared/paperChatSchemas'
import type { ProviderTokenUsage } from '../usageAnalyticsService'

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }
export type ChatFetcher = (url: string, init: RequestInit) => Promise<Response>
export class ChatProviderError extends Error {
  constructor(readonly code: string, message: string, readonly retryAfterMs?: number) { super(message) }
}
const usageSchema = z.object({ prompt_tokens: z.number().int().nonnegative(), completion_tokens: z.number().int().nonnegative(), total_tokens: z.number().int().nonnegative() })
const packetSchema = z.object({
  error: z.unknown().optional(),
  choices: z.array(z.object({ delta: z.object({ content: z.string().nullable().optional() }).passthrough(), finish_reason: z.string().nullable().optional() }).passthrough()).optional(),
  usage: usageSchema.nullable().optional()
}).passthrough()

/** Separate FIFO queues: chat never queues behind a translation request. */
export class ChatProvider {
  private readonly cooldowns = new Map<PaperChatProvider, number>()
  private readonly tails = new Map<PaperChatProvider, Promise<void>>()
  constructor(private readonly fetcher: ChatFetcher, private readonly options: { firstByteMs?: number; idleMs?: number; invalidate?(provider: PaperChatProvider): Promise<void> } = {}) {}

  stream(input: { provider: PaperChatProvider; baseUrl: string; model: string; key: string; messages: ChatMessage[]; signal: AbortSignal; onDelta(text: string): void | Promise<void> }): Promise<ProviderTokenUsage | null> {
    // The endpoint is never a renderer field, and even persisted settings must match the provider whitelist.
    const expected = input.provider === 'qwen' ? DEFAULT_SETTINGS.qwenBaseUrl : DEFAULT_SETTINGS.deepseekBaseUrl
    if (input.baseUrl !== expected) return Promise.reject(new ChatProviderError('PROVIDER_UNAVAILABLE', '问答服务地址不受支持'))
    const previous = this.tails.get(input.provider) ?? Promise.resolve()
    const run = previous.then(() => { input.signal.throwIfAborted(); return this.runStream(input) })
    this.tails.set(input.provider, run.then(() => undefined, () => undefined))
    return abortable(run, input.signal)
  }

  private async runStream(input: Parameters<ChatProvider['stream']>[0]): Promise<ProviderTokenUsage | null> {
    const remaining = (this.cooldowns.get(input.provider) ?? 0) - Date.now()
    if (remaining > 0) throw new ChatProviderError('EMBEDDING_RATE_LIMITED', '问答服务限流，请稍后重试', Math.ceil(remaining))
    const controller = new AbortController()
    const relay = (): void => controller.abort(input.signal.reason)
    input.signal.addEventListener('abort', relay, { once: true })
    if (input.signal.aborted) relay()
    const signal = controller.signal
    let timer: ReturnType<typeof setTimeout> | undefined
    const arm = (ms: number): void => {
      clearTimeout(timer)
      timer = setTimeout(() => controller.abort(new ChatProviderError('RAG_TIMEOUT', '模型响应超时，请重试')), ms)
    }
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const firstDeadline = Date.now() + (this.options.firstByteMs ?? 30_000)
      arm(Math.max(1, firstDeadline - Date.now()))
      const response = await abortable(this.fetcher(`${input.baseUrl.replace(/\/$/u, '')}/chat/completions`, {
        method: 'POST', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.key}` },
        body: JSON.stringify({ model: input.model, messages: input.messages, stream: true, stream_options: { include_usage: true }, max_tokens: 8_192 })
      }), signal)
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => undefined)
        await this.options.invalidate?.(input.provider)
        throw new ChatProviderError('CHAT_CREDENTIALS_REQUIRED', '模型凭据已失效，请重新验证')
      }
      if (response.status === 429) {
        const header = response.headers.get('Retry-After')
        const seconds = header && /^\d+(?:\.\d+)?$/u.test(header) ? Number(header) * 1000 : header ? Date.parse(header) - Date.now() : 1000
        const retryAfterMs = Number.isFinite(seconds) ? Math.min(86_400_000, Math.max(0, Math.ceil(seconds))) : 1000
        this.cooldowns.set(input.provider, Date.now() + retryAfterMs)
        await response.body?.cancel().catch(() => undefined)
        throw new ChatProviderError('EMBEDDING_RATE_LIMITED', '问答服务限流，请稍后重试', retryAfterMs)
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined)
        throw new ChatProviderError('PROVIDER_UNAVAILABLE', '问答服务暂时不可用')
      }
      reader = response.body.getReader()
      const decoder = new TextDecoder('utf-8', { fatal: true })
      let buffer = ''
      let data: string[] = []
      let done = false
      let usage: ProviderTokenUsage | null = null
      let first = true
      const dispatch = async (): Promise<void> => {
        if (!data.length) return
        const json = data.join('\n'); data = []
        if (json === '[DONE]') { done = true; return }
        let parsed: z.infer<typeof packetSchema>
        try { parsed = packetSchema.parse(JSON.parse(json)) } catch { throw new ChatProviderError('PROVIDER_UNAVAILABLE', '模型返回了无效串流') }
        if (parsed.error !== undefined) throw new ChatProviderError('PROVIDER_UNAVAILABLE', '模型串流返回错误')
        const delta = parsed.choices?.[0]?.delta.content
        if (delta) { signal.throwIfAborted(); await input.onDelta(delta) }
        if (parsed.usage) usage = { promptTokens: parsed.usage.prompt_tokens, completionTokens: parsed.usage.completion_tokens, totalTokens: parsed.usage.total_tokens }
      }
      while (!done) {
        arm(first ? Math.max(1, firstDeadline - Date.now()) : this.options.idleMs ?? 60_000)
        const part = await abortable(reader.read(), signal)
        signal.throwIfAborted()
        if (part.done) {
          buffer += decoder.decode()
          if (buffer.startsWith('data:')) data.push(buffer.slice(5).trimStart().replace(/\r$/u, ''))
          await dispatch()
          if (!done) throw new ChatProviderError('PROVIDER_UNAVAILABLE', '模型串流意外中断，请重试')
          break
        }
        if (part.value.byteLength) first = false
        buffer += decoder.decode(part.value, { stream: true })
        if (buffer.length + data.reduce((n, line) => n + line.length, 0) > 256 * 1024) throw new ChatProviderError('RAG_LIMIT_EXCEEDED', '模型串流片段过大')
        let end: number
        while ((end = buffer.indexOf('\n')) >= 0 && !done) {
          const line = buffer.slice(0, end).replace(/\r$/u, '')
          buffer = buffer.slice(end + 1)
          if (!line) await dispatch()
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /u, ''))
        }
      }
      return usage
    } catch (error) {
      if (signal.aborted) throw signal.reason
      if (error instanceof ChatProviderError) throw error
      throw new ChatProviderError('PROVIDER_UNAVAILABLE', '无法连接问答服务，请重试')
    } finally {
      clearTimeout(timer)
      input.signal.removeEventListener('abort', relay)
      await reader?.cancel().catch(() => undefined)
      reader?.releaseLock()
      controller.abort()
    }
  }
}

export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = (): void => reject(signal.reason)
    if (signal.aborted) { void promise.catch(() => undefined); stop(); return }
    signal.addEventListener('abort', stop, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop))
  })
}
