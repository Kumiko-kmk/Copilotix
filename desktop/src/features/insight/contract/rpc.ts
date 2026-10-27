import { z } from 'zod'
import { briefSourceSchema, paperBriefSaveSchema } from '../core/paperBrief/contracts'
import { archiveCoverSourceRequestSchema, archiveCoverSourceSchema, figureInsightDescriptorSchema, figureInsightRequestSchema, figureInsightSaveSchema, figureInsightStateSchema } from './figureInsight'
import { paperInsightRequestSchema, paperInsightSavedSchema, paperInsightStateSchema } from './paperInsight'
import { archiveInsightListRequestSchema, archiveInsightListResultSchema } from './archiveInsight'

/** Core RPC operations served by the insight stores in Utility (combined in app/contract/coreRpc.ts). */
export const insightOperations = {
  'figureInsight:get': { payload: figureInsightRequestSchema, result: figureInsightStateSchema },
  'figureInsight:cover-source': { payload: archiveCoverSourceRequestSchema, result: archiveCoverSourceSchema },
  'compute:figure-insight-descriptor': { payload: figureInsightRequestSchema, result: figureInsightDescriptorSchema },
  'figureInsight:save': { payload: figureInsightSaveSchema, result: z.object({ saved: z.literal(true) }).strict() },
  'insight:get': { payload: paperInsightRequestSchema, result: paperInsightStateSchema },
  'insight:list': { payload: archiveInsightListRequestSchema, result: archiveInsightListResultSchema },
  'insight:save-brief': { payload: paperBriefSaveSchema, result: paperInsightSavedSchema },
  'insight:brief-source': { payload: paperInsightRequestSchema, result: briefSourceSchema }
} as const
export type InsightOperations = typeof insightOperations
