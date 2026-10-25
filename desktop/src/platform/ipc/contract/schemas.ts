import { z } from 'zod'
import type { IpcError } from './envelope'

/** Request schema of channels that take no argument. */
export const noRequestSchema = z.undefined()
/** Response schema of handlers that return nothing. */
export const voidResponseSchema = z.undefined()
/** A path picked in a native dialog, or null when cancelled. */
export const outputDirectorySchema = z.string().max(32_768).nullable()

export const ipcErrorSchema: z.ZodType<IpcError> = z.object({
  code: z.string().min(1).max(128),
  message: z.string().min(1).max(32_768),
  retryable: z.boolean(),
  traceId: z.string().max(512).optional()
}).strict()

export function ipcEnvelopeSchema<T extends z.ZodType>(valueSchema: T) {
  return z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), value: valueSchema }).strict(),
    z.object({ ok: z.literal(false), error: ipcErrorSchema }).strict()
  ])
}
