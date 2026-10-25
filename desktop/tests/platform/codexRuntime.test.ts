import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexBackoff, CodexRuntime, CODEX_OVERRIDES, CODEX_BACKGROUND_CONCURRENCY, turnError } from '../../src/platform/codex/runtime/codexRuntime'
import { DEFAULT_CODEX_SETTINGS } from '@platform/codex/contract/codex'

const state = vi.hoisted(() => ({ scenario: 'success', starts: [] as unknown[], turns: [] as unknown[], connections: [] as EventEmitter[], snapshot: '', failTurns: 0, errorInfo: null as unknown }))
vi.mock('node:fs/promises', () => ({ access: vi.fn().mockResolvedValue(undefined), mkdir: vi.fn().mockResolvedValue(undefined), readFile: vi.fn(async () => { if (!state.snapshot) throw new Error('missing'); return state.snapshot }), writeFile: vi.fn(async (_path, data) => { state.snapshot = data }), rename: vi.fn().mockResolvedValue(undefined) }))
vi.mock('node:child_process', () => ({ execFile: Object.assign(() => undefined, { [Symbol.for('nodejs.util.promisify.custom')]: async () => ({ stdout: 'codex-cli 0.159.2' }) }) }))
vi.mock('../../src/platform/codex/runtime/codexConnection', () => ({ CodexConnection: class extends EventEmitter {
  constructor() { super(); state.connections.push(this) }
  notify() {}
  close() { this.emit('closed', new Error('closed')) }
  async request(method: string, params: Record<string, unknown>) {
    if (method === 'account/read') return { account: { type: 'chatgpt' } }
    if (method === 'config/read') return { config: { features: Object.fromEntries(Object.keys(CODEX_OVERRIDES).filter(k => k.startsWith('features.')).map(k => [k.slice(9), CODEX_OVERRIDES[k]])), web_search: 'disabled', mcp_servers: { example: {} } } }
    if (method === 'model/list') return { data: [{ model: 'test-model', displayName: 'Test', isDefault: true, inputModalities: ['text', 'image'], supportedReasoningEfforts: [{ reasoningEffort: 'low' }], defaultReasoningEffort: 'low' }], nextCursor: null }
    if (method === 'thread/start') { state.starts.push(params); return { thread: { id: 'thread' }, sandbox: { type: state.scenario === 'unsafe' ? 'dangerFullAccess' : 'readOnly' }, approvalPolicy: 'on-request' } }
    if (method === 'turn/interrupt') { this.emit('notification', 'turn/completed', { threadId: 'thread', turn: { status: 'interrupted' } }); return {} }
    if (method === 'turn/start') {
      state.turns.push(params)
      const turnNumber = state.turns.length
      setTimeout(() => {
        const emit = (name: string, data: Record<string, unknown>) => this.emit('notification', name, { threadId: 'thread', ...data })
        if (state.scenario === 'hang' || (state.scenario === 'first-hangs' && turnNumber === 1)) return
        if (state.scenario === 'crash') { this.close(); return }
        if (state.scenario === 'tool') { emit('item/started', { item: { id: 'tool', type: 'commandExecution' } }); return }
        if (turnNumber <= state.failTurns) {
          const failed = () => emit('turn/completed', { turn: { status: 'failed', error: { message: 'upstream text', codexErrorInfo: state.errorInfo } } })
          if (state.scenario !== 'partial-fail') { failed(); return }
          emit('item/started', { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer' } })
          emit('item/agentMessage/delta', { itemId: 'answer', delta: '半' })
          setTimeout(failed, 1); return
        }
        emit('item/started', { item: { id: 'comment', type: 'agentMessage', phase: 'commentary' } })
        emit('item/agentMessage/delta', { itemId: 'comment', delta: 'private commentary' })
        emit('item/completed', { item: { id: 'comment', type: 'agentMessage', phase: 'commentary', text: 'private commentary' } })
        emit('item/started', { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer' } })
        emit('item/agentMessage/delta', { itemId: 'answer', delta: '答' })
        emit('item/agentMessage/delta', { itemId: 'answer', delta: '案' })
        emit('item/completed', { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: '答案' } })
        emit('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 2, outputTokens: 2, totalTokens: 4 } } })
        emit('turn/completed', { turn: { status: state.scenario === 'failed' ? 'failed' : 'completed' } })
      }, 1)
      return { turn: { id: 'turn' } }
    }
    return {}
  }
} }))
afterEach(() => { state.snapshot = ''; state.scenario = 'success'; state.starts = []; state.turns = []; state.connections = []; state.failTurns = 0; state.errorInfo = null; vi.useRealTimers() })
const RATE_LIMITED = { responseTooManyFailedAttempts: { httpStatusCode: 429 } }
function fixture() {
  const log = vi.fn()
  const runtime = new CodexRuntime('C:/work', async () => ({ ...DEFAULT_CODEX_SETTINGS, executable: 'C:/Codex/codex.exe' }), log, { attempts: 3, rateLimitMs: 1, transientMs: 1, maxMs: 4 })
  const delta = vi.fn(), controller = new AbortController()
  const input = { model: 'test-model', messages: [{ role: 'user' as const, content: 'question' }], signal: controller.signal, onDelta: delta }
  return { runtime, delta, controller, input, log }
}
describe('Codex generation lifecycle', () => {
  it('lets an available process take queued work while another process is slow', async () => {
    state.scenario = 'first-hangs'
    const f = fixture(), slow = new AbortController()
    const first = f.runtime.generate({ ...f.input, signal: slow.signal })
    const rejected = expect(first).rejects.toThrow('stop slow')
    const fast = Array.from({ length: CODEX_BACKGROUND_CONCURRENCY }, () => f.runtime.generate(f.input))
    try {
      await vi.waitFor(() => expect(state.turns).toHaveLength(CODEX_BACKGROUND_CONCURRENCY + 1))
      await Promise.all(fast)
    } finally { slow.abort(new Error('stop slow')); await rejected; f.runtime.close() }
  })
  it('reuses a process slot while starting a fresh isolated thread for every request', async () => {
    const f = fixture()
    await f.runtime.generate({ ...f.input, lane: 'interactive', effort: 'low' })
    await f.runtime.generate({ ...f.input, lane: 'interactive', effort: 'low' })
    expect(state.connections).toHaveLength(1)
    expect(state.starts).toHaveLength(2)
    for (const start of state.starts) expect(start).toMatchObject({ ephemeral: true, config: { model_reasoning_effort: 'low' } })
    expect(state.turns).toHaveLength(2)
    f.runtime.close()
  })
  it('restores verified connection snapshots across runtime restarts', async () => {
    const settings = { ...DEFAULT_CODEX_SETTINGS, executable: 'C:/Codex/codex.exe' }
    const first = new CodexRuntime('C:/work', async () => settings)
    expect((await first.inspect(settings, 'test-model')).verifiedModels).toContain('test-model')
    first.close()
    const second = new CodexRuntime('C:/work', async () => settings)
    expect((await second.cached(settings))?.verifiedModels).toContain('test-model')
    expect((await second.inspect(settings)).verifiedModels).toContain('test-model')
    second.close()
  })
  it('streams final-answer deltas once, excludes commentary and preserves usage', async () => {
    const f = fixture()
    await expect(f.runtime.generate(f.input)).resolves.toEqual({ promptTokens: 2, completionTokens: 2, totalTokens: 4 })
    expect(f.delta.mock.calls.flat().join('')).toBe('答案')
    expect(f.delta).toHaveBeenCalledTimes(2)
    expect(state.turns[0]).toMatchObject({ input: [{ type: 'text', text: 'question' }], effort: 'low' })
    expect(state.starts[0]).toMatchObject({ ephemeral: true, sandbox: 'read-only', config: { 'mcp_servers.example.enabled': false, model_reasoning_effort: 'low' } })
    f.runtime.close()
  })
  it.each(['failed', 'crash', 'tool', 'unsafe'])('does not accept %s as success', async scenario => {
    state.scenario = scenario
    const f = fixture()
    await expect(f.runtime.generate(f.input)).rejects.toThrow()
    f.runtime.close()
  })
  it('cancels active and queued jobs without accepting late writes', async () => {
    state.scenario = 'hang'
    const f = fixture(), queued = new AbortController()
    const active = Array.from({ length: CODEX_BACKGROUND_CONCURRENCY }, () => f.runtime.generate(f.input))
    const second = f.runtime.generate({ ...f.input, signal: queued.signal })
    const one = Promise.all(active.map(p => expect(p).rejects.toThrow())), two = expect(second).rejects.toThrow()
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(state.turns).toHaveLength(CODEX_BACKGROUND_CONCURRENCY)
    queued.abort(new Error('queued cancellation')); f.controller.abort(new Error('active cancellation'))
    await Promise.all([one, two]); expect(f.delta).not.toHaveBeenCalled()
    f.runtime.close()
  })
  it('retries a rate-limited background turn on the same process after narrowing concurrency', async () => {
    state.failTurns = 2; state.errorInfo = RATE_LIMITED
    const f = fixture()
    await expect(f.runtime.generate(f.input)).resolves.toEqual({ promptTokens: 2, completionTokens: 2, totalTokens: 4 })
    expect(state.turns).toHaveLength(3); expect(state.connections).toHaveLength(1)
    expect(f.delta.mock.calls.flat().join('')).toBe('答案')
    expect(f.log).toHaveBeenCalledWith('codex.generation.failed', expect.objectContaining({ lane: 'background', attempt: 1, category: 'responseTooManyFailedAttempts:429', willRetry: true, concurrency: 4 }))
    expect(f.log).toHaveBeenCalledWith('codex.concurrency', { lane: 'background', concurrency: 2 })
    expect(JSON.stringify(f.log.mock.calls)).not.toMatch(/upstream text|question/u)
    f.runtime.close()
  })
  it('fails without retrying interactive, partial-output, non-retryable or exhausted turns', async () => {
    state.failTurns = 99; state.errorInfo = RATE_LIMITED
    const f = fixture()
    await expect(f.runtime.generate({ ...f.input, lane: 'interactive' })).rejects.toMatchObject({ code: 'EMBEDDING_RATE_LIMITED', retryable: true })
    expect(state.turns).toHaveLength(1)
    state.errorInfo = 'usageLimitExceeded'
    await expect(f.runtime.generate(f.input)).rejects.toThrow('额度'); expect(state.turns).toHaveLength(2)
    state.scenario = 'partial-fail'; state.errorInfo = { responseStreamDisconnected: { httpStatusCode: null } }
    await expect(f.runtime.generate(f.input)).rejects.toThrow('连接中断'); expect(state.turns).toHaveLength(3)
    expect(f.log).toHaveBeenCalledWith('codex.generation.failed', expect.objectContaining({ category: 'responseStreamDisconnected', partialOutput: true, willRetry: false }))
    state.scenario = 'success'; state.errorInfo = RATE_LIMITED
    await expect(f.runtime.generate(f.input)).rejects.toThrow('限流'); expect(state.turns).toHaveLength(6)
    f.runtime.close()
  })
  it('narrows once per cooldown window and restores slots after sustained success', () => {
    let now = 0
    const backoff = new CodexBackoff(8, { attempts: 6, rateLimitMs: 1000, transientMs: 100, maxMs: 4000 }, () => now, () => 0.5)
    const inFlight = backoff.epoch
    expect(backoff.failed(true, inFlight)).toBe(1000); expect(backoff.limit).toBe(4)
    now = 500; expect(backoff.failed(true, inFlight)).toBe(500); expect(backoff.limit).toBe(4)
    now = 1000; expect(backoff.failed(true, backoff.epoch)).toBe(2000); expect(backoff.limit).toBe(2)
    for (let i = 0; i < 4; i++) backoff.succeeded()
    expect(backoff.limit).toBe(3)
    backoff.failed(false, backoff.epoch); expect(backoff.limit).toBe(3)
  })
  it.each([
    ['rateLimitExceeded', 'EMBEDDING_RATE_LIMITED', true, 'rateLimitExceeded'],
    [RATE_LIMITED, 'EMBEDDING_RATE_LIMITED', true, 'responseTooManyFailedAttempts:429'],
    [{ httpConnectionFailed: { httpStatusCode: 503 } }, 'PROVIDER_UNAVAILABLE', true, 'httpConnectionFailed:503'],
    [{ responseStreamConnectionFailed: { httpStatusCode: 400 } }, 'PROVIDER_UNAVAILABLE', false, 'responseStreamConnectionFailed:400'],
    ['unauthorized', 'CHAT_CREDENTIALS_REQUIRED', false, 'unauthorized'],
    [{ 'not safe <x>': {} }, 'PROVIDER_UNAVAILABLE', false, 'unknown'],
    [null, 'PROVIDER_UNAVAILABLE', false, 'other']
  ])('classifies CodexErrorInfo %j', (info, code, retryable, category) => {
    expect(turnError(info)).toMatchObject({ code, retryable, category })
  })
  it('rejects a model missing from the current catalog before starting a turn', async () => {
    const f = fixture()
    await expect(f.runtime.generate({ ...f.input, model: 'removed-model' })).rejects.toThrow('重新选择')
    expect(state.starts).toEqual([]); f.runtime.close()
  })
})
