import { describe, expect, it, vi } from 'vitest'
import {
  CoreClient,
  CoreClientError,
  CORE_CANCELLED,
  CORE_PROTOCOL_ERROR,
  CORE_TIMEOUT,
  CORE_UNAVAILABLE
} from '@core/coreClient'
import {
  serializeCoreMessage,
  makeCoreEvent,
  makeCoreSuccessResponse
} from '@shared/coreRpcSchemas'

class MemoryTransport {
  readonly sent: string[] = []
  private listener: ((message: unknown) => void) | undefined

  send(message: string): void {
    this.sent.push(message)
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.listener = listener
    return () => { this.listener = undefined }
  }

  emit(message: unknown): void {
    this.listener?.(message)
  }
}

const readyEvent = serializeCoreMessage(makeCoreEvent('ready'))
const id1 = '00000000-0000-4000-8000-000000000011'
const id2 = '00000000-0000-4000-8000-000000000012'
const id3 = '00000000-0000-4000-8000-000000000013'

describe('CoreClient', () => {
  it('fails a missing ready handshake at ten seconds', async () => {
    vi.useFakeTimers()
    try {
      const transport = new MemoryTransport()
      const client = new CoreClient(transport, { handshakeTimeoutMs: 10_000 })
      const ready = client.waitReady()
      vi.advanceTimersByTime(9_999)
      expect(client.getState()).toBe('starting')
      vi.advanceTimersByTime(1)
      await expect(ready).rejects.toMatchObject({ code: CORE_TIMEOUT })
      expect(client.getState()).toBe('failed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses a thirty-second default command timeout and ignores its late response', async () => {
    vi.useFakeTimers()
    try {
      const transport = new MemoryTransport()
      const client = new CoreClient(transport, { requestId: () => id1 })
      transport.emit(readyEvent)
      const request = client.request('ping', {})
      await Promise.resolve()
      await Promise.resolve()
      expect(transport.sent).toHaveLength(1)
      vi.advanceTimersByTime(29_999)
      expect(client.getPendingCount()).toBe(1)
      vi.advanceTimersByTime(1)
      await expect(request).rejects.toMatchObject({ code: CORE_TIMEOUT, requestId: id1 })
      expect(client.getPendingCount()).toBe(0)
      const cancel = JSON.parse(transport.sent[1]!) as { operation: string; payload: { requestId: string } }
      expect(cancel.operation).toBe('cancel')
      expect(cancel.payload.requestId).toBe(id1)
      transport.emit(serializeCoreMessage(makeCoreSuccessResponse(id1, 'ping', { pong: true })))
      expect(client.getPendingCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects an aborted command and notifies the utility with cancel', async () => {
    const transport = new MemoryTransport()
    const client = new CoreClient(transport, { requestId: () => id2 })
    transport.emit(readyEvent)
    const controller = new AbortController()
    const request = client.request('ping', {}, { signal: controller.signal })
    await Promise.resolve()
    await Promise.resolve()
    controller.abort()
    await expect(request).rejects.toMatchObject({ code: CORE_CANCELLED, requestId: id2 })
    expect(JSON.parse(transport.sent[1]!).operation).toBe('cancel')
    expect(client.getPendingCount()).toBe(0)
  })

  it('normalizes malformed responses/events as protocol errors', async () => {
    const transport = new MemoryTransport()
    const protocolErrors: CoreClientError[] = []
    const client = new CoreClient(transport, {
      requestId: () => id3,
      onProtocolError: (error) => protocolErrors.push(error)
    })
    transport.emit(readyEvent)
    const request = client.request('ping', {})
    await Promise.resolve()
    await Promise.resolve()
    transport.emit({ version: 1, requestId: id3, ok: true, value: { pong: 'yes' } })
    await expect(request).rejects.toMatchObject({ code: CORE_PROTOCOL_ERROR })
    transport.emit({ version: 1, type: 'ready', payload: { unexpected: true } })
    expect(protocolErrors.map((error) => error.code)).toEqual([CORE_PROTOCOL_ERROR, CORE_PROTOCOL_ERROR])
  })

  it('fails all pending requests when the transport disappears', async () => {
    const transport = new MemoryTransport()
    const client = new CoreClient(transport, { requestId: () => id1 })
    transport.emit(readyEvent)
    const request = client.request('ping', {})
    await Promise.resolve()
    await Promise.resolve()
    client.fail(new CoreClientError(CORE_UNAVAILABLE, 'utility exited', true))
    await expect(request).rejects.toMatchObject({ code: CORE_UNAVAILABLE })
    expect(client.getState()).toBe('closed')
    await expect(client.request('ping', {})).rejects.toMatchObject({ code: CORE_UNAVAILABLE })
  })
})
