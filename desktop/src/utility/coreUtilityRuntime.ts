import {
  coreRequestIdSchema,
  coreRequestSchema,
  deserializeCoreMessage,
  makeCoreErrorResponse,
  makeCoreEvent,
  makeCoreSuccessResponse,
  serializeCoreMessage,
  type CoreMessage,
  type CoreOperation,
  type CoreRequest
} from '@shared/coreRpcSchemas'

export interface UtilityParentPortLike {
  on(event: 'message', listener: (event: { data: unknown } | unknown) => void): unknown
  off?(event: 'message', listener: (event: { data: unknown } | unknown) => void): unknown
  postMessage(message: string): void
}

export type CoreUtilityOperationHandler = (request: CoreRequest, signal: AbortSignal) => Promise<unknown> | unknown

export interface CoreUtilityRuntimeOptions {
  /** Explicit operation handlers are the extension point for later DB/compute work. */
  handlers?: Partial<Record<CoreOperation, CoreUtilityOperationHandler>>
  scheduleExit?: (callback: () => void) => void
  exit?: (code: number) => void
}

export interface CoreUtilityRuntime {
  dispose(): void
  receive(message: unknown): void
  getActiveCount(): number
}

interface ActiveOperation {
  controller: AbortController
  promise: Promise<void>
}

/**
 * Utility-side protocol loop. It intentionally imports only the shared contract;
 * DB, compute, renderer, token and network adapters are added in later phases.
 */
export function createCoreUtilityRuntime(
  port: UtilityParentPortLike,
  options: CoreUtilityRuntimeOptions = {}
): CoreUtilityRuntime {
  let disposed = false
  let draining = false
  let shuttingDown = false
  let shutdownScheduled = false
  const active = new Map<string, ActiveOperation>()

  const post = (message: CoreMessage): void => {
    if (disposed) return
    try {
      port.postMessage(serializeCoreMessage(message))
    } catch {
      // There is no safe recovery channel if the parent cannot receive data.
    }
  }

  const waitForActive = async (): Promise<void> => {
    // New work is rejected while draining, so this snapshot is stable.
    await Promise.all([...active.values()].map((operation) => operation.promise))
  }

  const sendError = (requestId: string | undefined, code: string, message: string, retryable: boolean): void => {
    if (!requestId || !coreRequestIdSchema.safeParse(requestId).success) return
    try {
      post(makeCoreErrorResponse(requestId, { code, message, retryable }))
    } catch {
      // Keep protocol failures contained to the utility process.
    }
  }

  const scheduleExit = options.scheduleExit ?? ((callback: () => void) => setTimeout(callback, 0))
  const exit = options.exit ?? ((code: number) => process.exit(code))

  const runOperation = (request: CoreRequest, controller: AbortController, resolveDone: () => void): void => {
    void (async () => {
      try {
        if (request.operation === 'ping') {
          const handler = options.handlers?.ping
          const value = handler
            ? await handler(request, controller.signal)
            : { pong: true }
          if (controller.signal.aborted) sendError(request.requestId, 'CORE_CANCELLED', 'Core RPC request cancelled', false)
          else post(makeCoreSuccessResponse(request.requestId, 'ping', value as { pong: true }))
        }
      } catch {
        if (controller.signal.aborted) sendError(request.requestId, 'CORE_CANCELLED', 'Core RPC request cancelled', false)
        else sendError(request.requestId, 'CORE_UNAVAILABLE', 'Core utility operation failed', false)
      } finally {
        active.delete(request.requestId)
        resolveDone()
      }
    })()
  }

  const handle = async (request: CoreRequest): Promise<void> => {
    if (disposed) return
    if (request.operation === 'cancel') {
      const target = active.get(request.payload.requestId)
      target?.controller.abort()
      post(makeCoreSuccessResponse(request.requestId, 'cancel', { cancelled: Boolean(target) }))
      return
    }
    if (request.operation === 'drain') {
      draining = true
      await waitForActive()
      post(makeCoreSuccessResponse(request.requestId, 'drain', { drained: true }))
      post(makeCoreEvent('drained', { drained: true }))
      return
    }
    if (request.operation === 'shutdown') {
      draining = true
      shuttingDown = true
      await waitForActive()
      post(makeCoreSuccessResponse(request.requestId, 'shutdown', { shutdown: true }))
      post(makeCoreEvent('shutdown', { shutdown: true }))
      if (!shutdownScheduled) {
        shutdownScheduled = true
        scheduleExit(() => exit(0))
      }
      return
    }
    if (draining || shuttingDown) {
      sendError(request.requestId, 'CORE_UNAVAILABLE', 'Core utility is draining', true)
      return
    }

    if (active.has(request.requestId)) {
      sendError(request.requestId, 'CORE_PROTOCOL_ERROR', 'Core RPC request ID is already active', false)
      return
    }

    // Register before invoking the handler. This avoids a synchronous handler
    // deleting itself before active.set() and leaving a stale operation behind.
    const controller = new AbortController()
    let resolveDone!: () => void
    const promise = new Promise<void>((resolve) => { resolveDone = resolve })
    active.set(request.requestId, { controller, promise })
    runOperation(request, controller, resolveDone)
  }

  const receive = (rawMessage: unknown): void => {
    if (disposed) return
    let message: CoreMessage
    try {
      message = deserializeCoreMessage(rawMessage)
    } catch {
      sendError(extractRequestId(rawMessage), 'CORE_PROTOCOL_ERROR', 'Core RPC message failed validation', false)
      return
    }
    const parsed = coreRequestSchema.safeParse(message)
    if (!parsed.success) {
      sendError(extractRequestId(rawMessage), 'CORE_PROTOCOL_ERROR', 'Core RPC request failed validation', false)
      return
    }
    if (draining && parsed.data.operation !== 'cancel' && parsed.data.operation !== 'shutdown') {
      sendError(parsed.data.requestId, 'CORE_UNAVAILABLE', 'Core utility is draining', true)
      return
    }
    void handle(parsed.data)
  }

  const listener = (message: { data: unknown } | unknown): void => receive(message)
  port.on('message', listener)
  post(makeCoreEvent('ready', {}))

  return {
    dispose: () => {
      if (disposed) return
      disposed = true
      for (const operation of active.values()) operation.controller.abort()
      active.clear()
      port.off?.('message', listener)
    },
    receive,
    getActiveCount: () => active.size
  }
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
