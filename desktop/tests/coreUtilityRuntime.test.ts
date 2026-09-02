import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { createCoreUtilityRuntime, type UtilityParentPortLike } from '../src/utility/coreUtilityRuntime'
import {
  deserializeCoreMessage,
  makeCoreEvent,
  serializeCoreMessage
} from '@shared/coreRpcSchemas'

class MemoryParentPort extends EventEmitter implements UtilityParentPortLike {
  readonly posted: string[] = []

  postMessage(message: string): void {
    this.posted.push(message)
  }

  on(event: 'message', listener: (event: { data: unknown } | unknown) => void): this {
    return super.on(event, listener)
  }

  off(event: 'message', listener: (event: { data: unknown } | unknown) => void): this {
    return super.off(event, listener)
  }

  receive(message: unknown): void {
    this.emit('message', { data: message })
  }
}

const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`

describe('core utility runtime', () => {
  it('announces ready and removes synchronous operations before drain', async () => {
    const port = new MemoryParentPort()
    const runtime = createCoreUtilityRuntime(port)
    expect(deserializeCoreMessage(port.posted[0]!)).toEqual(makeCoreEvent('ready'))

    port.receive(serializeCoreMessage({ version: 1, requestId: id('1'), operation: 'ping', payload: {} }))
    await Promise.resolve()
    await Promise.resolve()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(runtime.getActiveCount()).toBe(0)
    expect(deserializeCoreMessage(port.posted[1]!)).toMatchObject({ ok: true, value: { pong: true } })

    port.receive(serializeCoreMessage({ version: 1, requestId: id('2'), operation: 'drain', payload: {} }))
    await Promise.resolve()
    await Promise.resolve()
    expect(runtime.getActiveCount()).toBe(0)
    expect(port.posted.some((message) => {
      const parsed = deserializeCoreMessage(message)
      return 'type' in parsed && parsed.type === 'drained'
    })).toBe(true)
  })

  it('cancels a registered handler and emits a cancellation error', async () => {
    const port = new MemoryParentPort()
    let release!: () => void
    const running = new Promise<void>((resolve) => { release = resolve })
    const runtime = createCoreUtilityRuntime(port, {
      handlers: {
        ping: async (_request, signal) => {
          await Promise.race([running, new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))])
          if (signal.aborted) throw new Error('cancelled')
          return { pong: true }
        }
      }
    })
    const requestId = id('3')
    port.receive(serializeCoreMessage({ version: 1, requestId, operation: 'ping', payload: {} }))
    await Promise.resolve()
    expect(runtime.getActiveCount()).toBe(1)
    port.receive(serializeCoreMessage({ version: 1, requestId: id('4'), operation: 'cancel', payload: { requestId } }))
    await Promise.resolve()
    await Promise.resolve()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(runtime.getActiveCount()).toBe(0)
    const responses = port.posted.map((message) => deserializeCoreMessage(message))
    expect(responses).toContainEqual(expect.objectContaining({ ok: true, value: { cancelled: true } }))
    expect(responses).toContainEqual(expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'CORE_CANCELLED' }) }))
    release()
  })

  it('rejects malformed requests without throwing from the process loop', () => {
    const port = new MemoryParentPort()
    createCoreUtilityRuntime(port)
    port.receive(JSON.stringify({ version: 1, requestId: id('5'), operation: 'ping', payload: { unknown: true } }))
    const error = deserializeCoreMessage(port.posted[1]!)
    expect(error).toMatchObject({ ok: false, error: { code: 'CORE_PROTOCOL_ERROR' } })
  })
})
