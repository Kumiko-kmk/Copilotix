import { IpcClientError, type IpcEnvelope } from '@shared/ipc'
import { ipcEnvelopeSchema } from '@shared/ipcSchemas'
import { z } from 'zod'

export function decodeIpcResponse<T>(raw: unknown, schema: z.ZodType<T>): T {
  const envelope = ipcEnvelopeSchema(schema).parse(raw) as IpcEnvelope<T>
  if (!envelope.ok) throw new IpcClientError(envelope.error)
  return envelope.value
}

export function decodeIpcEvent<T>(raw: unknown, schema: z.ZodType<T>): T | null {
  const result = ipcEnvelopeSchema(schema).safeParse(raw)
  if (!result.success || !result.data.ok) return null
  return result.data.value
}
