import { z } from 'zod'
import { connectionFor, sharedModelRuntime } from './modelRuntime'
import { MODEL_ENDPOINTS } from '../contract/models'
import type { ModelProvider as PaperChatProvider, ProviderKey } from '../contract/models'
import type { ModelUsage as ProviderTokenUsage } from '../contract/models'
import type { MultimodalChatMessage } from '@platform/codex/contract/chatMessages'
export type { ChatMessage, ChatContentPart } from '@platform/codex/contract/chatMessages'

export type ChatFetcher = (url: string, init: RequestInit) => Promise<Response>
export class ChatProviderError extends Error {
  constructor(readonly code: string, message: string, readonly retryAfterMs?: number, readonly status?: number) { super(message) }
}
const usageSchema = z.object({ prompt_tokens: z.number().int().nonnegative(), completion_tokens: z.number().int().nonnegative(), total_tokens: z.number().int().nonnegative() })
const packetSchema = z.object({
  error: z.unknown().optional(),
  choices: z.array(z.object({ delta: z.object({ content: z.string().nullable().optional() }).passthrough(), finish_reason: z.string().nullable().optional() }).passthrough()).optional(),
  usage: usageSchema.nullable().optional()
}).passthrough()

/** Interactive FIFO and bounded background queues never wait for each other. */
export class ChatProvider {
  constructor(private readonly fetcher: ChatFetcher, private readonly options: { firstByteMs?: number; idleMs?: number; invalidate?(provider: Exclude<PaperChatProvider, 'codex'>): Promise<void> } = {}) {}

  stream(input: { purpose?: 'translation' | 'chat' | 'brief' | 'figure'; provider: Exclude<PaperChatProvider, 'codex'>; baseUrl: string; model: string; key?: string; keys?: readonly ProviderKey[]; messages: MultimodalChatMessage[]; signal: AbortSignal; onDelta(text: string): void | Promise<void>; temperature?: number; maxOutputTokens?: number; responseFormat?: { type: 'json_object' }; maxRequestBytes?: number; firstByteMs?: number; lane?: 'interactive' | 'background' }): Promise<ProviderTokenUsage | null> {
    // The endpoint is never a renderer field, and even persisted settings must match the provider whitelist.
    const expected = MODEL_ENDPOINTS[input.provider]
    if (input.baseUrl !== expected) return Promise.reject(new ChatProviderError('PROVIDER_UNAVAILABLE', '问答服务地址不受支持'))
    // keys are tried in order; a single key stands for the provider's default connection.
    const keys = input.keys ?? (input.key ? [{ connection: connectionFor(input.provider, input.baseUrl, input.key), key: input.key }] : [])
    if (!keys.length) return Promise.reject(new ChatProviderError('CHAT_CREDENTIALS_REQUIRED', '请先保存模型 API Key'))
    const byConnection = new Map(keys.map(entry => [entry.connection.connectionId, entry.key]))
    return sharedModelRuntime.execute({ purpose: input.purpose ?? 'chat', model: input.model, lane: input.lane ?? 'interactive', candidates: keys.map(entry => entry.connection), signal: input.signal }, async connection => {
      let partial = false
      try {
        const usage = await this.runStream({ ...input, key: byConnection.get(connection.connectionId)!, onDelta: async text => { partial ||= Boolean(text); await input.onDelta(text) } })
        return { value: usage, usage }
      } catch (error) { if (partial && error instanceof Error) Object.assign(error, { partialOutput: true }); throw error }
    }).then(result => result.value)
  }

  private async runStream(input: Parameters<ChatProvider['stream']>[0] & { key: string }): Promise<ProviderTokenUsage | null> {
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
      const firstDeadline = Date.now() + (input.firstByteMs ?? this.options.firstByteMs ?? 30_000)
      arm(Math.max(1, firstDeadline - Date.now()))
      const body: Record<string, unknown> = {
        model: input.model, messages: input.messages, stream: true, stream_options: { include_usage: true },
        max_tokens: input.maxOutputTokens ?? (input.provider === 'deepseek' && input.model === 'deepseek-v4-pro' ? 32_768 : 8_192),
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
        ...(input.responseFormat ? { response_format: input.responseFormat } : {}),
        ...(input.provider === 'qwen' && input.messages.some(message => Array.isArray(message.content))
          ? { enable_thinking: false } : {}),
        ...(input.provider === 'deepseek' && ['deepseek-flash', 'deepseek-v4-pro'].includes(input.model)
          ? { thinking: { type: input.responseFormat || input.model === 'deepseek-flash' ? 'disabled' : 'enabled' } } : {})
      }
      const send = (): Promise<Response> => {
        const serialized = JSON.stringify(body)
        if (input.maxRequestBytes !== undefined && Buffer.byteLength(serialized) > input.maxRequestBytes) {
          throw new ChatProviderError('RAG_LIMIT_EXCEEDED', '论文摘录超过模型输入预算')
        }
        return abortable(this.fetcher(`${input.baseUrl.replace(/\/$/u, '')}/chat/completions`, {
          method: 'POST', redirect: 'error', signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.key}` }, body: serialized
        }), signal)
      }
      const response = await send()
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => undefined)
        await this.options.invalidate?.(input.provider)
        throw new ChatProviderError('CHAT_CREDENTIALS_REQUIRED', '模型凭据已失效，请重新验证')
      }
      if (response.status === 429) {
        const header = response.headers.get('Retry-After')
        const seconds = header && /^\d+(?:\.\d+)?$/u.test(header) ? Number(header) * 1000 : header ? Date.parse(header) - Date.now() : 1000
        const retryAfterMs = Number.isFinite(seconds) ? Math.min(86_400_000, Math.max(0, Math.ceil(seconds))) : 1000
        await response.body?.cancel().catch(() => undefined)
        throw new ChatProviderError('EMBEDDING_RATE_LIMITED', '问答服务限流，请稍后重试', retryAfterMs)
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined)
        throw new ChatProviderError('PROVIDER_UNAVAILABLE', '问答服务暂时不可用', undefined, response.status)
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
      throw new ChatProviderError('MODEL_CONNECTION_FAILED', '无法连接问答服务，请重试')
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
