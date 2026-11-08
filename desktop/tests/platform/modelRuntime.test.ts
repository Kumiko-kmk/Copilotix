import { describe, expect, it, vi } from 'vitest'
import { ModelRuntime, ModelConnectionUnavailable, classifyModelFailure } from '@platform/models/runtime/modelRuntime'
import { defaultConnections } from '@platform/models/contract/models'
const connection = defaultConnections()[0]!
const signal = () => new AbortController().signal
function deferred<T = void>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
describe('shared model connections', () => {
  it('sends one first-use request, skips all waiting requests after failure, and probes once after cooldown', async () => {
    let now = 0
    const runtime = new ModelRuntime(() => now)
    const first = deferred()
    const send = vi.fn(() => first.promise)
    const batch = Promise.allSettled(Array.from({ length: 50 }, () => runtime.run(connection, 'background', signal(), send)))
    expect(send).toHaveBeenCalledTimes(1)
    first.reject(new TypeError('network'))
    const results = await batch
    expect(results.every(result => result.status === 'rejected')).toBe(true)
    expect(send).toHaveBeenCalledTimes(1)
    expect(runtime.health(connection.connectionId)).toMatchObject({ status: 'cooldown', nextAllowedAt: 30_000, failures: 1 })
    now = 30_000
    const probe = deferred()
    const resend = vi.fn(() => probe.promise)
    const next = Promise.allSettled(Array.from({ length: 30 }, () => runtime.run(connection, 'interactive', signal(), resend)))
    expect(resend).toHaveBeenCalledTimes(1)
    probe.reject({ status: 503 })
    await next
    expect(resend).toHaveBeenCalledTimes(1)
    expect(runtime.health(connection.connectionId)).toMatchObject({ nextAllowedAt: 90_000, failures: 2 })
    now = 90_000
    await runtime.run(connection, 'interactive', signal(), async () => 'recovered')
    expect(runtime.health(connection.connectionId).status).toBe('healthy')
  })
  it('reserves the interactive slot and checks health again before queued work sends', async () => {
    const runtime = new ModelRuntime()
    await runtime.run(connection, 'background', signal(), async () => undefined)
    const active = deferred()
    const send = vi.fn(() => active.promise)
    const background = Promise.allSettled(Array.from({ length: 35 }, () => runtime.run(connection, 'background', signal(), send)))
    expect(send).toHaveBeenCalledTimes(15)
    await expect(runtime.run(connection, 'interactive', signal(), async () => 'answer')).resolves.toBe('answer')
    active.reject({ status: 503 })
    await background
    expect(send).toHaveBeenCalledTimes(15)
  })
  it('cancels a first-validation waiter without sending or poisoning the connection', async () => {
    const runtime = new ModelRuntime()
    const active = deferred()
    const first = runtime.run(connection, 'background', signal(), () => active.promise)
    const controller = new AbortController(), send = vi.fn()
    const waiting = runtime.run(connection, 'interactive', controller.signal, send)
    controller.abort()
    await expect(waiting).rejects.toThrow()
    expect(send).not.toHaveBeenCalled()
    active.resolve()
    await first
    expect(runtime.health(connection.connectionId).status).toBe('healthy')
  })
  it('keeps invalid credentials blocked, but isolates request errors and resets changed configuration', async () => {
    const runtime = new ModelRuntime()
    await expect(runtime.run(connection, 'background', signal(), async () => { throw { status: 401 } })).rejects.toMatchObject({ status: 401 })
    await expect(runtime.run(connection, 'interactive', signal(), async () => undefined)).rejects.toBeInstanceOf(ModelConnectionUnavailable)
    await expect(runtime.run({ ...connection, configVersion: '2' }, 'interactive', signal(), async () => { throw { status: 400 } })).rejects.toMatchObject({ status: 400 })
    expect(runtime.health(connection.connectionId).status).toBe('healthy')
  })
  it('respects Retry-After and never repeats candidates or falls back after partial output', async () => {
    const runtime = new ModelRuntime(() => 0)
    const request = { purpose: 'translation' as const, lane: 'background' as const, model: 'fixture', candidates: [connection, connection, defaultConnections()[1]!], signal: signal() }
    const send = vi.fn(async () => { throw { status: 429, retryAfterMs: 600_000 } })
    await expect(runtime.execute(request, send)).rejects.toMatchObject({ status: 429 })
    expect(send).toHaveBeenCalledTimes(2)
    expect(runtime.health(connection.connectionId).nextAllowedAt).toBe(600_000)
    runtime.clear()
    const partial = vi.fn(async () => { throw Object.assign(new Error('interrupted'), { status: 503, partialOutput: true }) })
    await expect(runtime.execute(request, partial)).rejects.toMatchObject({ partialOutput: true })
    expect(partial).toHaveBeenCalledTimes(1)
  })
  it('returns actual connection provenance and usage without carrying credentials', async () => {
    const runtime = new ModelRuntime()
    const result = await runtime.execute({ purpose: 'chat', lane: 'interactive', model: 'fixture', candidates: [connection], signal: signal() }, async () => ({ value: 'ok', usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } }))
    expect(result).toEqual({ value: 'ok', usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 }, provider: 'qwen', connectionId: 'qwen:default', model: 'fixture', completion: 'completed' })
    expect(classifyModelFailure({ code: 'ECONNREFUSED' })).toBe('transient')
    expect(classifyModelFailure({ status: 404 })).toBe('request')
  })
})
