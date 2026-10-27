import { z } from 'zod'

/** The protocol is deliberately small and versioned before any data operation is added. */
export const CORE_RPC_VERSION = 1 as const
export const CORE_RPC_MAX_BYTES = 1024 * 1024

export const noNul = (value: string): boolean => !value.includes('\0')
const requestIdSchema = z.string().uuid().refine(noNul, 'requestId cannot contain NUL')
const boundedTextSchema = z.string().min(1).max(32_768).refine(noNul, 'text cannot contain NUL')
export const emptyPayloadSchema = z.object({}).strict()

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

export const corePathSchema = z.string().min(1).max(32_768).refine(noNul, 'path cannot contain NUL')
export const coreIdSchema = z.string().min(1).max(512).refine(noNul, 'id cannot contain NUL')
export const coreHashSchema = z.string().min(1).max(512).refine(noNul, 'hash cannot contain NUL')
export const coreTimestampSchema = z.string().min(1).max(128).refine(noNul, 'timestamp cannot contain NUL')

/** One Core RPC operation: strict schemas on both sides of the wire. */
export interface CoreOperationEntry {
  payload: z.ZodTypeAny
  result: z.ZodTypeAny
}
export type CoreOperationRegistry = Record<string, CoreOperationEntry>
export type CoreOperationOf<R extends CoreOperationRegistry> = Extract<keyof R, string>
export type CorePayloadOf<R extends CoreOperationRegistry, K extends keyof R> = z.infer<R[K]['payload']>
export type CoreResultOf<R extends CoreOperationRegistry, K extends keyof R> = z.infer<R[K]['result']>
export type CoreRequestOf<R extends CoreOperationRegistry> = {
  [K in CoreOperationOf<R>]: {
    version: typeof CORE_RPC_VERSION
    requestId: string
    operation: K
    payload: CorePayloadOf<R, K>
  }
}[CoreOperationOf<R>]

export interface CoreRequestOptions {
  signal?: AbortSignal
  timeoutMs?: number
  requestId?: string
}

/** The typed request surface a module needs; satisfied by the supervisor and by test doubles. */
export interface CoreRequester<R extends CoreOperationRegistry> {
  request<K extends CoreOperationOf<R>>(operation: K, payload: CorePayloadOf<R, K>, options?: CoreRequestOptions): Promise<CoreResultOf<R, K>>
}

export const corePingPayloadSchema = emptyPayloadSchema
export const corePingResultSchema = z.object({ pong: z.literal(true) }).strict()
export const coreCancelPayloadSchema = z.object({ requestId: requestIdSchema }).strict()
export const coreCancelResultSchema = z.object({ cancelled: z.boolean() }).strict()
export const coreDrainPayloadSchema = emptyPayloadSchema
export const coreDrainResultSchema = z.object({ drained: z.literal(true) }).strict()
export const coreShutdownPayloadSchema = emptyPayloadSchema
export const coreShutdownResultSchema = z.object({ shutdown: z.literal(true) }).strict()

export const coreDatabaseInitPayloadSchema = z.object({ databasePath: corePathSchema, outputRoot: corePathSchema }).strict()
export const coreDatabaseInitResultSchema = z.object({ initialized: z.literal(true) }).strict()
export const coreDatabaseFlushPayloadSchema = emptyPayloadSchema
export const coreDatabaseFlushResultSchema = z.object({ flushed: z.literal(true) }).strict()
export const coreDatabaseClosePayloadSchema = emptyPayloadSchema
export const coreDatabaseCloseResultSchema = z.object({ closed: z.literal(true) }).strict()

/** Lifecycle operations every utility understands; the app registry adds the feature operations. */
export const platformOperations = {
  ping: { payload: corePingPayloadSchema, result: corePingResultSchema },
  cancel: { payload: coreCancelPayloadSchema, result: coreCancelResultSchema },
  drain: { payload: coreDrainPayloadSchema, result: coreDrainResultSchema },
  shutdown: { payload: coreShutdownPayloadSchema, result: coreShutdownResultSchema },
  'database:init': { payload: coreDatabaseInitPayloadSchema, result: coreDatabaseInitResultSchema },
  'database:flush': { payload: coreDatabaseFlushPayloadSchema, result: coreDatabaseFlushResultSchema },
  'database:close': { payload: coreDatabaseClosePayloadSchema, result: coreDatabaseCloseResultSchema }
} as const
export type PlatformOperations = typeof platformOperations

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

export type CoreMessageOf<R extends CoreOperationRegistry> = CoreRequestOf<R> | CoreResponse | CoreEvent

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

export function makeCoreErrorResponse(requestId: string, error: CoreError): CoreResponse {
  try {
    return coreErrorResponseSchema.parse({ version: CORE_RPC_VERSION, requestId, ok: false, error })
  } catch {
    throw new CoreRpcProtocolError('Core RPC error response failed validation')
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

/** Wire validation bound to one operation registry; the app owns the complete registry. */
export interface CoreProtocol<R extends CoreOperationRegistry> {
  readonly registry: R
  readonly operationSchema: z.ZodType<CoreOperationOf<R>> & { readonly options: ReadonlyArray<CoreOperationOf<R>> }
  readonly requestSchema: z.ZodType<CoreRequestOf<R>>
  readonly messageSchema: z.ZodType<CoreMessageOf<R>>
  /** Validate and serialize a wire message with an explicit UTF-8 size bound. */
  serializeMessage(rawMessage: unknown): string
  /** Parse either Electron's structured-clone value or a serialized wire value. */
  deserializeMessage(rawMessage: unknown): CoreMessageOf<R>
  validateResult<K extends CoreOperationOf<R>>(operation: K, value: unknown): CoreResultOf<R, K>
  makeSuccessResponse<K extends CoreOperationOf<R>>(requestId: string, operation: K, value: CoreResultOf<R, K>): CoreResponse
}

export function createCoreProtocol<R extends CoreOperationRegistry>(registry: R): CoreProtocol<R> {
  const names = Object.keys(registry) as Array<CoreOperationOf<R>>
  const operationSchema = z.enum(names as [CoreOperationOf<R>, ...Array<CoreOperationOf<R>>]) as unknown as CoreProtocol<R>['operationSchema']
  const requestVariants = names.map((operation) => z.object({
    version: z.literal(CORE_RPC_VERSION),
    requestId: requestIdSchema,
    operation: z.literal(operation),
    payload: registry[operation]!.payload
  }).strict()) as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]
  // The registry is the authoritative runtime union. The cast only keeps
  // Zod's tuple requirement out of the operation declaration; every variant is
  // still strict and discriminated by `operation` at runtime.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const requestSchema = z.discriminatedUnion('operation', requestVariants as any) as unknown as z.ZodType<CoreRequestOf<R>>
  const messageSchema = z.union([requestSchema, coreResponseSchema, coreEventSchema]) as unknown as z.ZodType<CoreMessageOf<R>>

  const validateResult = <K extends CoreOperationOf<R>>(operation: K, value: unknown): CoreResultOf<R, K> => {
    try {
      return registry[operation]!.result.parse(value) as CoreResultOf<R, K>
    } catch {
      throw new CoreRpcProtocolError(`Core RPC result failed validation for ${operation}`)
    }
  }

  return {
    registry,
    operationSchema,
    requestSchema,
    messageSchema,
    serializeMessage(rawMessage) {
      let message: CoreMessageOf<R>
      try {
        message = messageSchema.parse(rawMessage)
      } catch {
        throw new CoreRpcProtocolError('Core RPC message failed validation')
      }

      if ('payload' in message) assertSize(message.payload, 'Core RPC payload exceeds 1 MiB')
      assertSize(message, 'Core RPC envelope exceeds 1 MiB')
      return safeStringify(message)
    },
    deserializeMessage(rawMessage) {
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
        const message = messageSchema.parse(value)
        if ('payload' in message) assertSize(message.payload, 'Core RPC payload exceeds 1 MiB')
        assertSize(message, 'Core RPC envelope exceeds 1 MiB')
        return message
      } catch (error) {
        if (error instanceof CoreRpcProtocolError) throw error
        throw new CoreRpcProtocolError('Core RPC message failed validation')
      }
    },
    validateResult,
    makeSuccessResponse(requestId, operation, value) {
      const result = validateResult(operation, value)
      try {
        return coreSuccessResponseSchema.parse({ version: CORE_RPC_VERSION, requestId, ok: true, value: result })
      } catch {
        throw new CoreRpcProtocolError('Core RPC success response failed validation')
      }
    }
  }
}
