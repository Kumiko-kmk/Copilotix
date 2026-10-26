import { z } from 'zod'
import { boundedId } from '@platform/ipc/contract/validation'
import type { TranslatedMarkdownBlock } from './translationTypes'

/** IPC schemas for translation providers and translated blocks. */

export const translationProviderIdSchema = z.enum(['qwen', 'deepseek', 'bing', 'transmart', 'codex'])

export const translatedMarkdownBlockSchema: z.ZodType<TranslatedMarkdownBlock> = z.object({
  sourceIndex: z.number().int().min(0).optional(),
  markdown: z.string().max(16_777_216),
  mappingIds: z.array(boundedId).max(100_000),
  fallbackProvider: translationProviderIdSchema.optional(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  sourceChanged: z.literal(true).optional()
}).strict()
