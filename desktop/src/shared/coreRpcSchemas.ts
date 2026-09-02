import { z } from 'zod'

/** The protocol is deliberately small and versioned before any data operation is added. */
export const CORE_RPC_VERSION = 1 as const
export const CORE_RPC_MAX_BYTES = 1024 * 1024

const noNul = (value: string): boolean => !value.includes('\0')
const requestIdSchema = z.string().uuid().refine(noNul, 'requestId cannot contain NUL')
const boundedTextSchema = z.string().min(1).max(32_768).refine(noNul, 'text cannot contain NUL')
const emptyPayloadSchema = z.object({}).strict()

export const coreRequestIdSchema = requestIdSchema

/**
 * Values crossing the process boundary are JSON values only. In particular, a
 * Buffer, typed array, ArrayBuffer, file handle, or stream must be represented by
 * a later operation-specific identifier rather than copied through RPC.
 */
function isRpcJsonValue(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null) return true
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true
    case 'number':
      return Number.isFinite(value)
    case 'undefined':
    case 'bigint':
    case 'function':
    case 'symbol':
      return false
    default:
      break
  }

  if (typeof ArrayBuffer !== 'undefined' && (value instanceof ArrayBuffer || ArrayBuffer.isView(value))) return false
  if (typeof value !== 'object') return false

  const objectValue = value as object
  if (seen.has(objectValue)) return false
  seen.add(objectValue)
  try {
    if (value instanceof Date || value instanceof Map || value instanceof Set || value instanceof RegExp) return false
    if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') return false

    if (Array.isArray(value)) return value.every((item) => isRpcJsonValue(item, seen))

    // Reject the common JSON representation produced by Buffer.toJSON().
    if (
      Object.prototype.hasOwnProperty.call(value, 'type') &&
      (value as { type?: unknown }).type === 'Buffer' &&
      Object.prototype.hasOwnProperty.call(value, 'data') &&
      Array.isArray((value as { data?: unknown }).data)
    ) return false

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return false
    return Object.entries(value as Record<string, unknown>).every(([key, item]) => noNul(key) && isRpcJsonValue(item, seen))
  } finally {
    seen.delete(objectValue)
  }
}

export const coreJsonValueSchema = z.custom<unknown>(isRpcJsonValue, 'RPC values must be JSON-safe')

export const coreOperationSchema = z.enum(['ping', 'cancel', 'drain', 'shutdown'])
export type CoreOperation = z.infer<typeof coreOperationSchema>

export const corePingPayloadSchema = emptyPayloadSchema
export const corePingResultSchema = z.object({ pong: z.literal(true) }).strict()
export const coreCancelPayloadSchema = z.object({ requestId: requestIdSchema }).strict()
export const coreCancelResultSchema = z.object({ cancelled: z.boolean() }).strict()
export const coreDrainPayloadSchema = emptyPayloadSchema
export const coreDrainResultSchema = z.object({ drained: z.literal(true) }).strict()
export const coreShutdownPayloadSchema = emptyPayloadSchema
export const coreShutdownResultSchema = z.object({ shutdown: z.literal(true) }).strict()

/**
 * The registry is the only source of operation payload/result types. Later DB or
 * compute operations must add one entry here with strict schemas on both sides.
 */
export const coreOperationRegistry = {
  ping: { payload: corePingPayloadSchema, result: corePingResultSchema },
  cancel: { payload: coreCancelPayloadSchema, result: coreCancelResultSchema },
  drain: { payload: coreDrainPayloadSchema, result: coreDrainResultSchema },
  shutdown: { payload: coreShutdownPayloadSchema, result: coreShutdownResultSchema }
} as const

export type CoreOperationPayload = {
  [K in CoreOperation]: z.infer<(typeof coreOperationRegistry)[K]['payload']>
}

export type CoreOperationResult = {
  [K in CoreOperation]: z.infer<(typeof coreOperationRegistry)[K]['result']>
}

const coreRequestVariants = [
  z.object({ version: z.literal(CORE_RPC_VERSION), requestId: requestIdSchema, operation: z.literal('ping'), payload: corePingPayloadSchema }).strict(),
  z.object({ version: z.literal(CORE_RPC_VERSION), requestId: requestIdSchema, operation: z.literal('cancel'), payload: coreCancelPayloadSchema }).strict(),
  z.object({ version: z.literal(CORE_RPC_VERSION), requestId: requestIdSchema, operation: z.literal('drain'), payload: coreDrainPayloadSchema }).strict(),
  z.object({ version: z.literal(CORE_RPC_VERSION), requestId: requestIdSchema, operation: z.literal('shutdown'), payload: coreShutdownPayloadSchema }).strict()
] as const

export const coreRequestSchema = z.discriminatedUnion('operation', coreRequestVariants)
export type CoreRequest = z.infer<typeof coreRequestSchema>

export const coreErrorSchema = z.object({
  code: z.string().min(1).max(128).refine(noNul, 'error code cannot contain NUL'),
  message: boundedTextSchema,
  retryable: z.boolean()
}).strict()
export type CoreError = z.infer<typeof coreErrorSchema>

export const coreSuccessResponseSchema = z.object({
  version: z.literal(CORE_RPC_VERSION),
  requestId: requestIdSchema,
  ok: z.literal(true),
  value: coreJsonValueSchema
}).strict()

export const coreErrorResponseSchema = z.object({
  version: z.literal(CORE_RPC_VERSION),
  requestId: requestIdSchema,
  ok: z.literal(false),
  error: coreErrorSchema
}).strict()

/** Success and error are exact, mutually exclusive response envelopes. */
export const coreResponseSchema = z.discriminatedUnion('ok', [coreSuccessResponseSchema, coreErrorResponseSchema])
export type CoreResponse = z.infer<typeof coreResponseSchema>

const coreReadyEventSchema = z.object({ version: z.literal(CORE_RPC_VERSION), type: z.literal('ready'), payload: emptyPayloadSchema }).strict()
const coreDrainedEventSchema = z.object({ version: z.literal(CORE_RPC_VERSION), type: z.literal('drained'), payload: z.object({ drained: z.literal(true) }).strict() }).strict()
const coreShutdownEventSchema = z.object({ version: z.literal(CORE_RPC_VERSION), type: z.literal('shutdown'), payload: z.object({ shutdown: z.literal(true) }).strict() }).strict()
const coreErrorEventSchema = z.object({ version: z.literal(CORE_RPC_VERSION), type: z.literal('error'), payload: coreErrorSchema }).strict()

export const coreEventTypeSchema = z.enum(['ready', 'drained', 'shutdown', 'error'])
export type CoreEventType = z.infer<typeof coreEventTypeSchema>

export const coreEventSchema = z.discriminatedUnion('type', [
  coreReadyEventSchema,
  coreDrainedEventSchema,
  coreShutdownEventSchema,
  coreErrorEventSchema
])
export type CoreEvent = z.infer<typeof coreEventSchema>

export const coreMessageSchema = z.union([coreRequestSchema, coreResponseSchema, coreEventSchema])
export type CoreMessage = z.infer<typeof coreMessageSchema>

export class CoreRpcProtocolError extends Error {
  readonly code = 'CORE_PROTOCOL_ERROR' as const
  readonly retryable = false as const

  constructor(message = 'Core RPC protocol error') {
    super(message)
    this.name = 'CoreRpcProtocolError'
  }
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function safeStringify(value: unknown): string {
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) throw new Error('undefined JSON')
    return serialized
  } catch {
    throw new CoreRpcProtocolError('Core RPC message is not serializable')
  }
}

function assertSize(value: unknown, message: string): void {
  if (!isRpcJsonValue(value)) throw new CoreRpcProtocolError('Core RPC message contains unsupported binary data')
  if (utf8ByteLength(safeStringify(value)) > CORE_RPC_MAX_BYTES) throw new CoreRpcProtocolError(message)
}

/** Validate and serialize a wire message with an explicit UTF-8 size bound. */
export function serializeCoreMessage(rawMessage: unknown): string {
  let message: CoreMessage
  try {
    message = coreMessageSchema.parse(rawMessage)
  } catch {
    throw new CoreRpcProtocolError('Core RPC message failed validation')
  }

  if ('payload' in message) assertSize(message.payload, 'Core RPC payload exceeds 1 MiB')
  assertSize(message, 'Core RPC envelope exceeds 1 MiB')
  return safeStringify(message)
}

/** Parse either Electron's structured-clone value or a serialized wire value. */
export function deserializeCoreMessage(rawMessage: unknown): CoreMessage {
  const raw = unwrapMessageEvent(rawMessage)
  let value: unknown = raw
  if (typeof raw === 'string') {
    if (utf8ByteLength(raw) > CORE_RPC_MAX_BYTES) throw new CoreRpcProtocolError('Core RPC envelope exceeds 1 MiB')
    try {
      value = JSON.parse(raw) as unknown
    } catch {
      throw new CoreRpcProtocolError('Core RPC message is not valid JSON')
    }
  }

  try {
    const message = coreMessageSchema.parse(value)
    if ('payload' in message) assertSize(message.payload, 'Core RPC payload exceeds 1 MiB')
    assertSize(message, 'Core RPC envelope exceeds 1 MiB')
    return message
  } catch (error) {
    if (error instanceof CoreRpcProtocolError) throw error
    throw new CoreRpcProtocolError('Core RPC message failed validation')
  }
}

export function validateCoreRequest(raw: unknown): CoreRequest {
  try {
    return coreRequestSchema.parse(raw)
  } catch {
    throw new CoreRpcProtocolError('Core RPC request failed validation')
  }
}

export function validateCoreOperationResult<K extends CoreOperation>(operation: K, value: unknown): CoreOperationResult[K] {
  try {
    return coreOperationRegistry[operation].result.parse(value) as CoreOperationResult[K]
  } catch {
    throw new CoreRpcProtocolError(`Core RPC result failed validation for ${operation}`)
  }
}

export function makeCoreErrorResponse(requestId: string, error: CoreError): CoreResponse {
  try {
    return coreErrorResponseSchema.parse({ version: CORE_RPC_VERSION, requestId, ok: false, error })
  } catch {
    throw new CoreRpcProtocolError('Core RPC error response failed validation')
  }
}

export function makeCoreSuccessResponse<K extends CoreOperation>(
  requestId: string,
  operation: K,
  value: CoreOperationResult[K]
): CoreResponse {
  const result = validateCoreOperationResult(operation, value)
  try {
    return coreSuccessResponseSchema.parse({ version: CORE_RPC_VERSION, requestId, ok: true, value: result })
  } catch {
    throw new CoreRpcProtocolError('Core RPC success response failed validation')
  }
}

export function makeCoreEvent(type: 'ready', payload?: CoreEvent['payload']): CoreEvent
export function makeCoreEvent(type: 'drained', payload?: CoreEvent['payload']): CoreEvent
export function makeCoreEvent(type: 'shutdown', payload?: CoreEvent['payload']): CoreEvent
export function makeCoreEvent(type: 'error', payload: CoreError): CoreEvent
export function makeCoreEvent(type: CoreEventType, payload: CoreEvent['payload'] = {}): CoreEvent {
  try {
    return coreEventSchema.parse({ version: CORE_RPC_VERSION, type, payload })
  } catch {
    throw new CoreRpcProtocolError('Core RPC event failed validation')
  }
}

function unwrapMessageEvent(raw: unknown): unknown {
  if (raw && typeof raw === 'object' && 'data' in raw) return (raw as { data: unknown }).data
  return raw
}
