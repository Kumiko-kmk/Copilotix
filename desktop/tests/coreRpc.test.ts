import { describe, expect, it } from 'vitest'
import {
  CORE_RPC_MAX_BYTES,
  CORE_RPC_VERSION,
  CoreRpcProtocolError,
  coreErrorResponseSchema,
  coreEventSchema,
  coreRequestSchema,
  coreResponseSchema,
  coreTranslationBatchCommitPayloadSchema,
  deserializeCoreMessage,
  makeCoreEvent,
  serializeCoreMessage,
  validateCoreOperationResult
} from '@shared/coreRpcSchemas'
import {
  translationPlanResponseEnvelopeSchema,
  translationPlanWorkDescriptorSchema
} from '@shared/translationPlanProtocol'

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

  it('counts CJK batch payloads by UTF-8 bytes at the 768 KiB boundary', () => {
    const block = (blockId: string) => ({
      blockId,
      sourceHash: 'source-hash',
      sourceMarkdown: '界'.repeat(262_144),
      translatedMarkdown: null,
      provider: null,
      model: null,
      status: 'pending' as const,
      error: null
    })
    const payload = {
      taskId: '00000000-0000-4000-8000-000000000002',
      jobId: '00000000-0000-4000-8000-000000000003',
      blocks: [block('block-1'), block('block-2')],
      cacheEntries: []
    }
    expect(JSON.stringify(payload).length).toBeLessThan(768 * 1024)
    expect(new TextEncoder().encode(JSON.stringify(payload)).byteLength).toBeGreaterThan(768 * 1024)
    expect(coreTranslationBatchCommitPayloadSchema.safeParse(payload).success).toBe(false)
  })

  it('counts CJK batch payloads by UTF-8 bytes at the 768 KiB boundary', () => {
    const block = (blockId: string) => ({
      blockId,
      sourceHash: 'source-hash',
      sourceMarkdown: '界'.repeat(262_144),
      translatedMarkdown: null,
      provider: null,
      model: null,
      status: 'pending' as const,
      error: null
    })
    const payload = {
      taskId: '00000000-0000-4000-8000-000000000002',
      jobId: '00000000-0000-4000-8000-000000000003',
      blocks: [block('block-1'), block('block-2')],
      cacheEntries: []
    }
    expect(JSON.stringify(payload).length).toBeLessThan(768 * 1024)
    expect(new TextEncoder().encode(JSON.stringify(payload)).byteLength).toBeGreaterThan(768 * 1024)
    expect(coreTranslationBatchCommitPayloadSchema.safeParse(payload).success).toBe(false)
  })

  it('constructs only valid event payloads', () => {
    expect(makeCoreEvent('ready')).toEqual({ version: 1, type: 'ready', payload: {} })
    expect(makeCoreEvent('drained', { drained: true })).toEqual({ version: 1, type: 'drained', payload: { drained: true } })
    expect(() => makeCoreEvent('error', { code: 'x', message: 'bad', retryable: false, extra: true } as never)).toThrow(CoreRpcProtocolError)
  })

  it('binds translation response kind to its protocol and keeps descriptors metadata-only', () => {
    const unitId = '00000000-0000-4000-8000-000000000002'
    const sourceHash = 'a'.repeat(64)
    const plainResponse = {
      protocol: 'copilotix-translation-plain-v1' as const,
      unitId,
      sourceHash,
      translations: []
    }
    const tableResponse = {
      protocol: 'copilotix-table-translation-v2' as const,
      translations: []
    }
    expect(translationPlanResponseEnvelopeSchema.safeParse({
      protocol: 'copilotix-translation-response-v1', unitId, kind: 'plain', sourceHash, response: plainResponse
    }).success).toBe(true)
    expect(translationPlanResponseEnvelopeSchema.safeParse({
      protocol: 'copilotix-translation-response-v1', unitId, kind: 'plain', sourceHash, response: tableResponse
    }).success).toBe(false)
    expect(translationPlanResponseEnvelopeSchema.safeParse({
      protocol: 'copilotix-translation-response-v1', unitId, kind: 'table', sourceHash, response: plainResponse
    }).success).toBe(false)
    expect(translationPlanResponseEnvelopeSchema.safeParse({
      protocol: 'copilotix-translation-response-v1',
      unitId,
      kind: 'plain',
      sourceHash,
      response: { ...plainResponse, sourceHash: 'b'.repeat(64) }
    }).success).toBe(false)

    const descriptor = {
      unitId,
      kind: 'plain' as const,
      sourceHash,
      blockIds: ['translation-block-1'],
      requestPath: '.translation/job/requests/unit.json',
      responsePath: '.translation/job/responses/unit.json',
      resultPath: '.translation/job/results/unit.md',
      status: 'pending' as const
    }
    expect(translationPlanWorkDescriptorSchema.safeParse(descriptor).success).toBe(true)
    expect(translationPlanWorkDescriptorSchema.safeParse({ ...descriptor, sourceMarkdown: '正文' }).success).toBe(false)
    expect(translationPlanWorkDescriptorSchema.safeParse({ ...descriptor, requestPath: 'C:/outside/request.json' }).success).toBe(false)
  })
})
