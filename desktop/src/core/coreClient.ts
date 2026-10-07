import {
  CORE_RPC_VERSION,
  coreRequestIdSchema,
  coreRequestSchema,
  deserializeCoreMessage,
  serializeCoreMessage,
  validateCoreOperationResult,
  type CoreEvent,
  type CoreMessage,
  type CoreOperation,
  type CoreOperationPayload,
  type CoreOperationResult,
  type CoreResponse
} from '@shared/coreRpcSchemas'

export const CORE_TIMEOUT = 'CORE_TIMEOUT' as const
export const CORE_UNAVAILABLE = 'CORE_UNAVAILABLE' as const
export const CORE_PROTOCOL_ERROR = 'CORE_PROTOCOL_ERROR' as const
export const CORE_CANCELLED = 'CORE_CANCELLED' as const

export type CoreClientErrorCode =
  | typeof CORE_TIMEOUT
  | typeof CORE_UNAVAILABLE
  | typeof CORE_PROTOCOL_ERROR
  | typeof CORE_CANCELLED
  | string

export class CoreClientError extends Error {
  readonly code: CoreClientErrorCode
  readonly retryable: boolean
  readonly requestId?: string

  constructor(code: CoreClientErrorCode, message: string, retryable = false, requestId?: string) {
    super(message)
    this.name = 'CoreClientError'
    this.code = code
    this.retryable = retryable
    this.requestId = requestId
  }
}

/** A deliberately transport-agnostic adapter for Electron, tests, or another IPC transport. */
export interface CoreTransport {
  send(message: string): void
  onMessage(listener: (message: unknown) => void): () => void
}

export type CoreClientState = 'starting' | 'ready' | 'failed' | 'closed'

export interface CoreClientOptions {
  handshakeTimeoutMs?: number
  requestTimeoutMs?: number
  requestId?: () => string
  setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void
  onProtocolError?: (error: CoreClientError) => void
  onStateChange?: (state: CoreClientState) => void
}

export interface CoreRequestOptions {
  signal?: AbortSignal
  timeoutMs?: number
  requestId?: string
}

interface PendingRequest {
  operation: CoreOperation
  resolve: (value: unknown) => void
  reject: (reason?: unknown) => void
  timeoutHandle: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  abortListener?: () => void
}

/**
 * Main-process client for the supervised utility protocol.  It owns one pending
 * map and never reuses a request after it has settled, so late responses are safe
 * to ignore.
 */
export class CoreClient {
  private readonly transport: CoreTransport
  private readonly handshakeTimeoutMs: number
  private readonly requestTimeoutMs: number
  private readonly requestIdFactory: () => string
  private readonly schedule: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  private readonly cancelSchedule: (handle: ReturnType<typeof setTimeout>) => void
  private readonly protocolErrorListener?: (error: CoreClientError) => void
  private readonly stateListener?: (state: CoreClientState) => void
  private readonly pending = new Map<string, PendingRequest>()
  private readonly eventListeners = new Set<(event: CoreEvent) => void>()
  private readonly readyPromise: Promise<void>
  private readyResolve!: () => void
  private readyReject!: (reason?: unknown) => void
  private unsubscribe: (() => void) | undefined
  private handshakeTimer: ReturnType<typeof setTimeout> | undefined
  private state: CoreClientState = 'starting'
  private settledReady = false

  constructor(transport: CoreTransport, options: CoreClientOptions = {}) {
    this.transport = transport
    this.handshakeTimeoutMs = positiveTimeout(options.handshakeTimeoutMs ?? 10_000, 10_000)
    this.requestTimeoutMs = positiveTimeout(options.requestTimeoutMs ?? 30_000, 30_000)
    this.requestIdFactory = options.requestId ?? defaultRequestId
    this.schedule = options.setTimeout ?? setTimeout
    this.cancelSchedule = options.clearTimeout ?? clearTimeout
    this.protocolErrorListener = options.onProtocolError
    this.stateListener = options.onStateChange
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    this.unsubscribe = transport.onMessage((message) => this.handleMessage(message))
    this.handshakeTimer = this.schedule(() => {
      this.fail(new CoreClientError(CORE_TIMEOUT, 'Core utility handshake timed out', true))
    }, this.handshakeTimeoutMs)
  }

  getState(): CoreClientState {
    return this.state
  }

  getPendingCount(): number {
    return this.pending.size
  }

  waitReady(signal?: AbortSignal): Promise<void> {
    if (this.state === 'ready') return Promise.resolve()
    if (this.state === 'failed' || this.state === 'closed') {
      return Promise.reject(new CoreClientError(CORE_UNAVAILABLE, 'Core utility is unavailable', true))
    }
    if (!signal) return this.readyPromise
    if (signal.aborted) return Promise.reject(cancelledError())

    return new Promise<void>((resolve, reject) => {
      let settled = false
      const onAbort = (): void => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        reject(cancelledError())
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.readyPromise.then(() => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, (error: unknown) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        reject(error)
      })
    })
  }

  onEvent(listener: (event: CoreEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  request<K extends CoreOperation>(
    operation: K,
    payload: CoreOperationPayload[K],
    options: CoreRequestOptions = {}
  ): Promise<CoreOperationResult[K]> {
    // Always return a promise, including for invalid caller data/request IDs.
    return Promise.resolve().then(() => {
      if (this.state === 'failed' || this.state === 'closed') {
        throw new CoreClientError(CORE_UNAVAILABLE, 'Core utility is unavailable', true)
      }
      if (options.signal?.aborted) throw cancelledError()

      const requestId = options.requestId ?? this.createRequestId()
      if (this.pending.has(requestId)) {
        throw new CoreClientError(CORE_PROTOCOL_ERROR, 'Core RPC request ID is already pending', false, requestId)
      }

      let request: Extract<CoreMessage, { operation: K }>
      try {
        request = coreRequestSchema.parse({ version: CORE_RPC_VERSION, requestId, operation, payload }) as Extract<CoreMessage, { operation: K }>
      } catch {
        throw new CoreClientError(CORE_PROTOCOL_ERROR, 'Core RPC request failed validation', false, requestId)
      }
      return this.waitReady(options.signal).then(() => this.sendRequest(request, options))
    })
  }

  /** Reject all work when the process disappears and detach all listeners. */
  fail(error = new CoreClientError(CORE_UNAVAILABLE, 'Core utility exited unexpectedly', true)): void {
    if (this.state === 'closed' || this.state === 'failed') return
    this.state = error.code === CORE_TIMEOUT ? 'failed' : 'closed'
    this.clearHandshakeTimer()
    this.unsubscribe?.()
    this.unsubscribe = undefined
    if (!this.settledReady) {
      this.settledReady = true
      this.readyReject(error)
    }
    for (const requestId of [...this.pending.keys()]) this.rejectPending(requestId, error, false)
    this.stateListener?.(this.state)
  }

  close(): void {
    this.fail(new CoreClientError(CORE_UNAVAILABLE, 'Core utility closed', false))
  }

  dispose(): void {
    this.close()
    this.eventListeners.clear()
  }

  private sendRequest<K extends CoreOperation>(
    request: Extract<CoreMessage, { operation: K }>,
    options: CoreRequestOptions
  ): Promise<CoreOperationResult[K]> {
    const timeoutMs = positiveTimeout(options.timeoutMs ?? this.requestTimeoutMs, this.requestTimeoutMs)
    return new Promise<CoreOperationResult[K]>((resolve, reject) => {
      if (this.state !== 'ready') {
        reject(new CoreClientError(CORE_UNAVAILABLE, 'Core utility is unavailable', true, request.requestId))
        return
      }
      if (options.signal?.aborted) {
        reject(cancelledError(request.requestId))
        return
      }

      const timeoutHandle = this.schedule(() => {
        this.rejectPending(request.requestId, new CoreClientError(CORE_TIMEOUT, 'Core RPC request timed out', true, request.requestId), true)
      }, timeoutMs)
      const pending: PendingRequest = {
        operation: request.operation,
        resolve: (value) => resolve(value as CoreOperationResult[K]),
        reject,
        timeoutHandle,
        signal: options.signal
      }
      if (options.signal) {
        const abortListener = (): void => {
          this.rejectPending(request.requestId, cancelledError(request.requestId), true)
        }
        pending.abortListener = abortListener
        options.signal.addEventListener('abort', abortListener, { once: true })
      }
      this.pending.set(request.requestId, pending)
      try {
        this.transport.send(serializeCoreMessage(request))
      } catch (error) {
        const protocolFailure = error instanceof Error && error.name === 'CoreRpcProtocolError'
        this.rejectPending(
          request.requestId,
          new CoreClientError(protocolFailure ? CORE_PROTOCOL_ERROR : CORE_UNAVAILABLE, protocolFailure ? 'Core RPC request failed validation' : 'Core utility is unavailable', !protocolFailure, request.requestId),
          false
        )
      }
    })
  }

  private handleMessage(raw: unknown): void {
    let message: CoreMessage
    try {
      message = deserializeCoreMessage(raw)
    } catch {
      const requestId = extractRequestId(raw)
      const error = new CoreClientError(CORE_PROTOCOL_ERROR, 'Core RPC message failed validation', false, requestId)
      if (requestId && this.pending.has(requestId)) this.rejectPending(requestId, error, false)
      this.notifyProtocolError(error)
      return
    }
    if ('ok' in message) {
      this.handleResponse(message)
      return
    }
    if ('operation' in message) {
      this.notifyProtocolError(new CoreClientError(CORE_PROTOCOL_ERROR, 'Unexpected Core RPC request', false, message.requestId))
      return
    }
    this.handleEvent(message)
  }

  private handleResponse(response: CoreResponse): void {
    const pending = this.pending.get(response.requestId)
    if (!pending) return
    this.clearPending(response.requestId, pending)
    if (!response.ok) {
      pending.reject(new CoreClientError(response.error.code, response.error.message, response.error.retryable, response.requestId))
      return
    }
    try {
      const result = validateCoreOperationResult(pending.operation, response.value)
      pending.resolve(result)
    } catch {
      const error = new CoreClientError(CORE_PROTOCOL_ERROR, 'Core RPC result failed validation', false, response.requestId)
      pending.reject(error)
      this.notifyProtocolError(error)
    }
  }

  private handleEvent(event: CoreEvent): void {
    if (event.type === 'ready' && this.state === 'starting') {
      this.state = 'ready'
      this.settledReady = true
      this.clearHandshakeTimer()
      this.readyResolve()
      this.stateListener?.(this.state)
    }
    for (const listener of this.eventListeners) {
      try {
        listener(event)
      } catch {
        // An observer cannot be allowed to break the transport listener.
      }
    }
  }

  private rejectPending(requestId: string, error: CoreClientError, notifyUtility: boolean): void {
    const pending = this.pending.get(requestId)
    if (!pending) return
    this.clearPending(requestId, pending)
    pending.reject(error)
    if (notifyUtility) this.sendCancel(requestId)
  }

  private clearPending(requestId: string, pending: PendingRequest): void {
    this.pending.delete(requestId)
    this.cancelSchedule(pending.timeoutHandle)
    if (pending.signal && pending.abortListener) pending.signal.removeEventListener('abort', pending.abortListener)
  }

  private sendCancel(requestId: string): void {
    if (this.state !== 'ready') return
    try {
      const cancelRequest = coreRequestSchema.parse({
        version: CORE_RPC_VERSION,
        requestId: this.createRequestId(),
        operation: 'cancel',
        payload: { requestId }
      })
      this.transport.send(serializeCoreMessage(cancelRequest))
    } catch {
      // The original timeout/cancellation remains the caller-visible result.
    }
  }

  private createRequestId(): string {
    let requestId: string
    try {
      requestId = this.requestIdFactory()
    } catch {
      throw new CoreClientError(CORE_UNAVAILABLE, 'Secure request ID generator is unavailable', true)
    }
    if (!coreRequestIdSchema.safeParse(requestId).success) {
      throw new CoreClientError(CORE_PROTOCOL_ERROR, 'Core RPC request ID failed validation')
    }
    return requestId
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer === undefined) return
    this.cancelSchedule(this.handshakeTimer)
    this.handshakeTimer = undefined
  }

  private notifyProtocolError(error: CoreClientError): void {
    try {
      this.protocolErrorListener?.(error)
    } catch {
      // Observability callbacks must never affect RPC state.
    }
  }
}

function defaultRequestId(): string {
  const cryptoApi = globalThis.crypto
  if (!cryptoApi?.randomUUID) throw new Error('Secure request ID generator is unavailable')
  return cryptoApi.randomUUID()
}

function cancelledError(requestId?: string): CoreClientError {
  return new CoreClientError(CORE_CANCELLED, 'Core RPC request cancelled', false, requestId)
}

function positiveTimeout(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function extractRequestId(raw: unknown): string | undefined {
  let value: unknown = raw
  if (raw && typeof raw === 'object' && 'data' in raw) value = (raw as { data: unknown }).data
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown
    } catch {
      return undefined
    }
  }
  if (!value || typeof value !== 'object' || !('requestId' in value)) return undefined
  const requestId = (value as { requestId?: unknown }).requestId
  return coreRequestIdSchema.safeParse(requestId).success ? requestId as string : undefined
}

