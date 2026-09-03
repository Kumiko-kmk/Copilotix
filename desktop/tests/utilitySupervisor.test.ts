import { describe, expect, it, vi } from 'vitest'
import {
  UtilitySupervisor,
  type UtilityFork,
  type UtilityProcessLike
} from '@main/utilitySupervisor'
import {
  deserializeCoreMessage,
  makeCoreEvent,
  makeCoreSuccessResponse,
  serializeCoreMessage
} from '@shared/coreRpcSchemas'

type MessageListener = (message: unknown) => void
type ExitListener = (code: number) => void
type ErrorListener = (...args: unknown[]) => void

class FakeUtilityProcess implements UtilityProcessLike {
  readonly posted: string[] = []
  killed = false
  respondToPing = true
  exitOnKill = true
  exitOnShutdown = false
  private readonly messageListeners = new Set<MessageListener>()
  private readonly exitListeners = new Set<ExitListener>()
  private readonly errorListeners = new Set<ErrorListener>()

  on(event: 'message', listener: MessageListener): this
  on(event: 'exit', listener: ExitListener): this
  on(event: 'error', listener: ErrorListener): this
  on(event: 'message' | 'exit' | 'error', listener: MessageListener | ExitListener | ErrorListener): this {
    if (event === 'message') this.messageListeners.add(listener as MessageListener)
    else if (event === 'exit') this.exitListeners.add(listener as ExitListener)
    else this.errorListeners.add(listener as ErrorListener)
    return this
  }

  off(event: 'message', listener: MessageListener): this
  off(event: 'exit', listener: ExitListener): this
  off(event: 'error', listener: ErrorListener): this
  off(event: 'message' | 'exit' | 'error', listener: MessageListener | ExitListener | ErrorListener): this {
    if (event === 'message') this.messageListeners.delete(listener as MessageListener)
    else if (event === 'exit') this.exitListeners.delete(listener as ExitListener)
    else this.errorListeners.delete(listener as ErrorListener)
    return this
  }

  removeListener(event: 'message', listener: MessageListener): this
  removeListener(event: 'exit', listener: ExitListener): this
  removeListener(event: 'error', listener: ErrorListener): this
  removeListener(event: 'message' | 'exit' | 'error', listener: MessageListener | ExitListener | ErrorListener): this {
    return this.off(event as never, listener as never)
  }

  postMessage(message: string): void {
    this.posted.push(message)
    const parsed = deserializeCoreMessage(message)
    if (!('operation' in parsed)) return
    if (parsed.operation === 'ping' && this.respondToPing) {
      this.emitMessage(serializeCoreMessage(makeCoreSuccessResponse(parsed.requestId, 'ping', { pong: true })))
    } else if (parsed.operation === 'drain') {
      this.emitMessage(serializeCoreMessage(makeCoreSuccessResponse(parsed.requestId, 'drain', { drained: true })))
    } else if (parsed.operation === 'shutdown') {
      this.emitMessage(serializeCoreMessage(makeCoreSuccessResponse(parsed.requestId, 'shutdown', { shutdown: true })))
      if (this.exitOnShutdown) this.emitExit(0)
    } else if (parsed.operation === 'cancel') {
      this.emitMessage(serializeCoreMessage(makeCoreSuccessResponse(parsed.requestId, 'cancel', { cancelled: true })))
    }
  }

  kill(): boolean {
    this.killed = true
    if (this.exitOnKill) this.emitExit(1)
    return true
  }

  emitMessage(message: unknown): void {
    for (const listener of this.messageListeners) listener(message)
  }

  emitExit(code: number): void {
    for (const listener of [...this.exitListeners]) listener(code)
  }

  emitError(...args: unknown[]): void {
    for (const listener of this.errorListeners) listener(...args)
  }

  listenerCount(event: 'message' | 'exit' | 'error'): number {
    return event === 'message' ? this.messageListeners.size : event === 'exit' ? this.exitListeners.size : this.errorListeners.size
  }
}

const ready = serializeCoreMessage(makeCoreEvent('ready'))

describe('UtilitySupervisor', () => {
  it('fails pending calls immediately on crash and removes process listeners', async () => {
    const child = new FakeUtilityProcess()
    child.respondToPing = false
    const fork: UtilityFork = () => {
      queueMicrotask(() => child.emitMessage(ready))
      return child
    }
    const supervisor = new UtilitySupervisor({ entryPath: 'utility.js', fork })
    await supervisor.start()
    const pending = supervisor.request('ping', {})
    await Promise.resolve()
    await Promise.resolve()
    child.emitExit(1)
    await expect(pending).rejects.toMatchObject({ code: 'CORE_UNAVAILABLE' })
    expect(supervisor.getState()).toBe('restarting')
    expect(child.listenerCount('message')).toBe(0)
    expect(child.listenerCount('exit')).toBe(0)
    expect(child.listenerCount('error')).toBe(0)
    await supervisor.shutdown()
  })

  it('counts startup failures and applies 250ms, 1s, 4s restart delays, then stops', async () => {
    vi.useFakeTimers()
    try {
      const fork = vi.fn(() => { throw new Error('spawn failed') }) as unknown as UtilityFork
      const supervisor = new UtilitySupervisor({
        entryPath: 'utility.js',
        fork,
        maxRestarts: 3,
        restartDelaysMs: [250, 1_000, 4_000]
      })
      const starting = supervisor.start()
      await Promise.resolve()
      expect(fork).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(249)
      expect(fork).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(1)
      await Promise.resolve()
      expect(fork).toHaveBeenCalledTimes(2)
      vi.advanceTimersByTime(1_000)
      await Promise.resolve()
      expect(fork).toHaveBeenCalledTimes(3)
      vi.advanceTimersByTime(4_000)
      await Promise.resolve()
      expect(fork).toHaveBeenCalledTimes(4)
      await expect(starting).rejects.toMatchObject({ code: 'CORE_UNAVAILABLE' })
      expect(supervisor.getRestartAttempts()).toBe(3)
      expect(supervisor.getState()).toBe('failed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects new work while draining and kills a non-exiting process at five seconds', async () => {
    vi.useFakeTimers()
    try {
      const child = new FakeUtilityProcess()
      child.exitOnKill = false
      const fork: UtilityFork = () => {
        queueMicrotask(() => child.emitMessage(ready))
        return child
      }
      const supervisor = new UtilitySupervisor({ entryPath: 'utility.js', fork, shutdownTimeoutMs: 5_000 })
      await supervisor.start()
      const stopping = supervisor.shutdown()
      expect(supervisor.getState()).toBe('draining')
      await expect(supervisor.request('ping', {})).rejects.toMatchObject({ code: 'CORE_UNAVAILABLE' })
      await Promise.resolve()
      await Promise.resolve()
      vi.advanceTimersByTime(4_999)
      expect(child.killed).toBe(false)
      vi.advanceTimersByTime(1)
      await stopping
      expect(child.killed).toBe(true)
      expect(supervisor.getState()).toBe('stopped')
      expect(child.listenerCount('message')).toBe(0)
      expect(child.listenerCount('exit')).toBe(0)
      expect(child.listenerCount('error')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('kills a utility that never handshakes without waiting for the handshake timeout', async () => {
    const child = new FakeUtilityProcess()
    const fork: UtilityFork = () => child
    const supervisor = new UtilitySupervisor({ entryPath: 'utility.js', fork, handshakeTimeoutMs: 10_000 })
    const starting = supervisor.start()
    await Promise.resolve()
    const startedAt = Date.now()
    await supervisor.shutdown()
    expect(Date.now() - startedAt).toBeLessThan(5_000)
    expect(child.killed).toBe(true)
    await expect(starting).rejects.toMatchObject({ code: 'CORE_UNAVAILABLE' })
    expect(supervisor.getState()).toBe('stopped')
  })
})
