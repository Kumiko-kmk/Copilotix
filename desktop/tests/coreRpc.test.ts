import { describe, expect, it } from 'vitest'
import {
  CORE_RPC_MAX_BYTES,
  CORE_RPC_VERSION,
  CoreRpcProtocolError,
  coreErrorResponseSchema,
  coreEventSchema,
  coreRequestSchema,
  coreResponseSchema,
  deserializeCoreMessage,
  makeCoreEvent,
  serializeCoreMessage,
  validateCoreOperationResult
} from '@shared/coreRpcSchemas'

const requestId = '00000000-0000-4000-8000-000000000001'

describe('core RPC schemas', () => {
  it('uses strict, discriminated envelopes and operation payloads', () => {
    const request = { version: CORE_RPC_VERSION, requestId, operation: 'ping', payload: {} }
    expect(coreRequestSchema.parse(request)).toEqual(request)
    expect(coreRequestSchema.safeParse({ ...request, extra: true }).success).toBe(false)
    expect(coreRequestSchema.safeParse({ ...request, payload: { extra: true } }).success).toBe(false)
    expect(coreResponseSchema.safeParse({ version: 1, requestId, ok: true, value: { pong: true }, error: {} }).success).toBe(false)
    expect(coreErrorResponseSchema.safeParse({ version: 1, requestId, ok: false, error: { code: 'x', message: 'bad', retryable: false }, value: null }).success).toBe(false)
    expect(coreEventSchema.safeParse({ version: 1, type: 'ready', payload: {}, extra: true }).success).toBe(false)
    expect(validateCoreOperationResult('ping', { pong: true })).toEqual({ pong: true })
    expect(() => validateCoreOperationResult('ping', { pong: false })).toThrow(CoreRpcProtocolError)
  })

  it('accepts the exact UTF-8 envelope boundary and rejects one byte over', () => {
    const makeMessage = (length: number) => ({ version: 1, requestId, ok: true as const, value: 'a'.repeat(length) })
    let low = 0
    let high = CORE_RPC_MAX_BYTES
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      const candidate = makeMessage(middle)
      if (new TextEncoder().encode(JSON.stringify(candidate)).byteLength <= CORE_RPC_MAX_BYTES) low = middle
      else high = middle - 1
    }
    const exact = serializeCoreMessage(makeMessage(low))
    expect(new TextEncoder().encode(exact).byteLength).toBe(CORE_RPC_MAX_BYTES)
    expect(() => serializeCoreMessage(makeMessage(low + 1))).toThrow(CoreRpcProtocolError)
    expect(() => serializeCoreMessage({ version: 1, requestId, ok: true, value: '界'.repeat(400_000) })).toThrow(CoreRpcProtocolError)
  })

  it('rejects binary/file-shaped values and JSON stringify failures safely', () => {
    expect(() => serializeCoreMessage({ version: 1, requestId, ok: true, value: Buffer.from('pdf') })).toThrow(CoreRpcProtocolError)
    expect(() => serializeCoreMessage({ version: 1, requestId, ok: true, value: { type: 'Buffer', data: [1, 2, 3] } })).toThrow(CoreRpcProtocolError)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => serializeCoreMessage({ version: 1, requestId, ok: true, value: cyclic })).toThrow(CoreRpcProtocolError)
    const throwing = { toJSON: () => { throw new Error('should not be exposed') } }
    expect(() => serializeCoreMessage({ version: 1, requestId, ok: true, value: throwing })).toThrow(CoreRpcProtocolError)
    expect(() => deserializeCoreMessage('{not json')).toThrow(CoreRpcProtocolError)
  })

  it('constructs only valid event payloads', () => {
    expect(makeCoreEvent('ready')).toEqual({ version: 1, type: 'ready', payload: {} })
    expect(makeCoreEvent('drained', { drained: true })).toEqual({ version: 1, type: 'drained', payload: { drained: true } })
    expect(() => makeCoreEvent('error', { code: 'x', message: 'bad', retryable: false, extra: true } as never)).toThrow(CoreRpcProtocolError)
  })
})
