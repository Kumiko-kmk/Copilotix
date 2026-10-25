export interface IpcError {
  code: string
  message: string
  retryable: boolean
  traceId?: string
}

export interface IpcSuccessEnvelope<T> {
  ok: true
  value: T
}

export interface IpcFailureEnvelope {
  ok: false
  error: IpcError
}

export type IpcEnvelope<T> = IpcSuccessEnvelope<T> | IpcFailureEnvelope

export function ipcSuccess<T>(value: T): IpcSuccessEnvelope<T> {
  return { ok: true, value }
}

export function ipcFailure(error: IpcError): IpcFailureEnvelope {
  return { ok: false, error }
}

export class IpcClientError extends Error {
  readonly code: string
  readonly traceId?: string

  constructor(error: IpcError) {
    super(error.message)
    this.name = 'IpcClientError'
    this.code = error.code
    this.traceId = error.traceId
  }
}
