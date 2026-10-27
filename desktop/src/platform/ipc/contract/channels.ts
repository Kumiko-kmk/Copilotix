import type { z } from 'zod'

/**
 * One renderer → Main request channel. Main registers it with
 * `IpcRegistrar.handle`, preload exposes it through `IpcBridge.invoke`; both
 * sides validate with the same schemas.
 */
export interface InvokeChannel<Request, Response> {
  readonly channel: string
  readonly request: z.ZodType<Request>
  readonly response: z.ZodType<Response>
}

/** One Main → renderer event channel. */
export interface EventChannel<Payload> {
  readonly channel: string
  readonly payload: z.ZodType<Payload>
}

export function invokeChannel<Request, Response>(channel: string, request: z.ZodType<Request>, response: z.ZodType<Response>): InvokeChannel<Request, Response> {
  return { channel, request, response }
}

export function eventChannel<Payload>(channel: string, payload: z.ZodType<Payload>): EventChannel<Payload> {
  return { channel, payload }
}

/** The preload side of the channels, handed to each feature's API factory. */
export interface IpcBridge {
  invoke<Request, Response>(channel: InvokeChannel<Request, Response>, request: Request): Promise<Response>
  /** Listens for valid event envelopes only; returns the unsubscribe function. */
  subscribe<Payload>(channel: EventChannel<Payload>, listener: (payload: Payload) => void): () => void
}
