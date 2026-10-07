import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/constants'
import { abortable, ChatProvider, type ChatFetcher } from '../src/main/chat/chatProvider'

const encoder = new TextEncoder()
const packet = (text: string): string => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`
const done = 'data: [DONE]\n\n'
function response(text: string, step = 7): Response {
  const bytes = encoder.encode(text)
  return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += step) controller.enqueue(bytes.slice(i, i + step)); controller.close() } }))
}
function input(onDelta = vi.fn(), signal = new AbortController().signal) {
  return { provider: 'qwen' as const, baseUrl: DEFAULT_SETTINGS.qwenBaseUrl, model: 'qwen-plus', key: 'secret-key', messages: [{ role: 'user' as const, content: 'question' }], signal, onDelta }
}
afterEach(() => vi.restoreAllMocks())

describe('ChatProvider', () => {
  it('parses fragmented UTF-8, CRLF, comments, multiline data and usage; requests the exact whitelisted endpoint', async () => {
    const fetcher = vi.fn<ChatFetcher>(async () => response(': keepalive\r\n\r\n' + packet('你好😀').replace(/\n/gu, '\r\n') + 'data: {"choices":\ndata: [{"delta":{"content":"world"}}]}\n\n' + 'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}\n\n' + done, 1))
    const onDelta = vi.fn()
    await expect(new ChatProvider(fetcher).stream(input(onDelta))).resolves.toEqual({ promptTokens: 2, completionTokens: 3, totalTokens: 5 })
    expect(onDelta.mock.calls.map(([s]) => s).join('')).toBe('你好😀world')
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe(DEFAULT_SETTINGS.qwenBaseUrl + '/chat/completions')
    expect(init.redirect).toBe('error')
    expect(JSON.parse(init.body as string)).toMatchObject({ stream: true, stream_options: { include_usage: true }, model: 'qwen-plus' })
  })
  it('supports DeepSeek and final DONE without a newline', async () => {
    const fetcher = vi.fn(async () => response(packet('ok') + 'data: [DONE]'))
    await new ChatProvider(fetcher).stream({ ...input(), provider: 'deepseek', baseUrl: DEFAULT_SETTINGS.deepseekBaseUrl, model: 'deepseek-flash' })
    expect(fetcher.mock.calls.length).toBe(1)
  })
  it.each([401, 403])('invalidates the stored credential on %s without exposing provider bodies', async (status) => {
    const invalidate = vi.fn(async () => undefined)
    const provider = new ChatProvider(async () => new Response('question secret echoed', { status }), { invalidate })
    await expect(provider.stream(input())).rejects.toMatchObject({ code: 'CHAT_CREDENTIALS_REQUIRED' })
    expect(invalidate).toHaveBeenCalledWith('qwen')
  })
  it.each(['2', 'bogus', null])('honors Retry-After %s and avoids more billable requests during cooldown', async (retry) => {
    const fetcher = vi.fn(async () => new Response('', { status: 429, headers: retry ? { 'Retry-After': retry } : {} }))
    const provider = new ChatProvider(fetcher)
    await expect(provider.stream(input())).rejects.toMatchObject({ code: 'EMBEDDING_RATE_LIMITED', retryAfterMs: retry === '2' ? 2000 : 1000 })
    await expect(provider.stream(input())).rejects.toMatchObject({ code: 'EMBEDDING_RATE_LIMITED' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('accepts a date Retry-After header', async () => {
    const next = new Date(Date.now() + 5000).toUTCString()
    const provider = new ChatProvider(async () => new Response('', { status: 429, headers: { 'Retry-After': next } }))
    await expect(provider.stream(input())).rejects.toMatchObject({ code: 'EMBEDDING_RATE_LIMITED' })
  })
  it('rejects renderer-like custom endpoints before touching the network', async () => {
    const fetcher = vi.fn()
    await expect(new ChatProvider(fetcher).stream({ ...input(), baseUrl: 'https://attacker.test' })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('times out headers/first byte even if fake fetch ignores AbortSignal', async () => {
    const provider = new ChatProvider(() => new Promise(() => undefined), { firstByteMs: 10 })
    await expect(provider.stream(input())).rejects.toMatchObject({ code: 'RAG_TIMEOUT' })
  })
  it('times out an idle stream and closes the reader', async () => {
    const cancel = vi.fn()
    const stream = new ReadableStream({ start(c) { c.enqueue(encoder.encode(packet('first'))) }, cancel })
    await expect(new ChatProvider(async () => new Response(stream), { firstByteMs: 100, idleMs: 10 }).stream(input())).rejects.toMatchObject({ code: 'RAG_TIMEOUT' })
    expect(cancel).toHaveBeenCalled()
  })
  it('cancels immediately, preventing later deltas', async () => {
    const controller = new AbortController()
    const onDelta = vi.fn(() => controller.abort())
    await expect(new ChatProvider(async () => response(packet('first') + packet('second') + done)).stream(input(onDelta, controller.signal))).rejects.toThrow()
    expect(onDelta).toHaveBeenCalledTimes(1)
  })
  it('serializes requests per provider, allowing another provider to proceed and cancelled queued work to skip fetch', async () => {
    let finish!: () => void
    const fetcher = vi.fn<ChatFetcher>(async (url) => url.includes('deepseek') ? response(done) : new Response(new ReadableStream({ start(c) { finish = () => { c.enqueue(encoder.encode(done)); c.close() } } })))
    const provider = new ChatProvider(fetcher)
    const first = provider.stream(input())
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    const controller = new AbortController()
    const queued = provider.stream(input(vi.fn(), controller.signal))
    controller.abort()
    await expect(queued).rejects.toThrow()
    await provider.stream({ ...input(), provider: 'deepseek', baseUrl: DEFAULT_SETTINGS.deepseekBaseUrl })
    finish(); await first
    await new Promise((r) => setTimeout(r, 0))
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it.each([
    'data: not-json\n\n',
    'data: {"error":{"message":"question echoed"}}\n\n',
    'data: {"usage":{"prompt_tokens":-1}}\n\n',
    packet('partial'),
    'data: ' + 'x'.repeat(262145),
  ])('rejects invalid or incomplete streams with safe errors', async (text) => {
    await expect(new ChatProvider(async () => response(text, 262144)).stream(input())).rejects.toMatchObject({ code: text.length > 262144 ? 'RAG_LIMIT_EXCEEDED' : 'PROVIDER_UNAVAILABLE' })
  })
  it('handles network and HTTP errors without forwarding raw exception text', async () => {
    await expect(new ChatProvider(async () => { throw new Error('secret question') }).stream(input())).rejects.toMatchObject({ message: '无法连接问答服务，请重试' })
    await expect(new ChatProvider(async () => new Response('secret', { status: 500 })).stream(input())).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' })
    await expect(new ChatProvider(async () => new Response(null)).stream(input())).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' })
  })
  it('handles already aborted operations and rejects broken UTF-8', async () => {
    const controller = new AbortController(); controller.abort()
    await expect(abortable(Promise.resolve(1), controller.signal)).rejects.toThrow()
    await expect(new ChatProvider(async () => new Response(new Uint8Array([255]))).stream(input())).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' })
  })
  it.each([['deepseek-flash', 'disabled', 8192], ['deepseek-v4-pro', 'enabled', 32768]])('sets the documented thinking mode for %s and ignores reasoning packets', async (model, thinking, maxTokens) => {
    const fetcher = vi.fn<ChatFetcher>(async () => response('data: {"choices":[{"delta":{"reasoning_content":"internal reasoning"}}]}\n\n' + packet('final answer') + done))
    const onDelta = vi.fn()
    await new ChatProvider(fetcher).stream({ ...input(onDelta), provider: 'deepseek', baseUrl: DEFAULT_SETTINGS.deepseekBaseUrl, model })
    expect(JSON.parse(String(fetcher.mock.calls[0]![1].body))).toMatchObject({ model, thinking: { type: thinking }, max_tokens: maxTokens })
    expect(onDelta.mock.calls).toEqual([['final answer']])
  })

})
