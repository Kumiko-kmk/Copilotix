import { z } from 'zod'
export const chatUsageSchema = z.object({
  promptTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  completionTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  totalTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
}).strict()
export const chatResultMetadataSchema = z.object({
  model: z.string().min(1).max(128),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  durationMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  usage: chatUsageSchema.nullable()
}).strict()
