import { z } from 'zod'
import { documentWorkflowStatusSchema } from '@features/library/contract/documentSchemas'
import { documentTimestamp, noNul } from '@platform/ipc/contract/validation'

export const ARCHIVE_INSIGHT_PAGE_SIZE = 200
export const archiveInsightListRequestSchema = z.object({
  documentIds: z.array(z.uuid()).max(ARCHIVE_INSIGHT_PAGE_SIZE)
}).strict()

/** Local catalog metadata only; no paths, full paper, excerpts, PNGs or model requests. */
export const archiveInsightSnapshotSchema = z.object({
  documentId: z.uuid(),
  updatedAt: documentTimestamp,
  workflowStatus: documentWorkflowStatusSchema,
  savedStatus: z.enum(['ready', 'missing', 'stale', 'failed']),
  ready: z.boolean(),
  translatedTitle: z.string().max(512).refine(noNul),
  keywords: z.array(z.string().max(80).refine(noNul)).max(8),
  tldr: z.string().max(120).refine(noNul)
}).strict().refine(row => !row.ready || (row.workflowStatus === 'completed' && row.savedStatus === 'ready'), {
  message: 'Archive readiness requires completed processing and a valid current saved card'
})
export const archiveInsightListResultSchema = z.array(archiveInsightSnapshotSchema).max(ARCHIVE_INSIGHT_PAGE_SIZE)
export type ArchiveInsightSnapshot = z.infer<typeof archiveInsightSnapshotSchema>
