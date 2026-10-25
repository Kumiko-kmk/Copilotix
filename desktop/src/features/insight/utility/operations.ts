import type { CoreUtilityOperationHandler } from '@platform/rpc/utility/coreUtilityRuntime'
import type { V2TaskRepositoryCompat } from '../../../utility/core/persistence/v2TaskRepositoryCompat'
import type { InsightOperations } from '../contract/rpc'
import { figureInsightRequestSchema, figureInsightSaveSchema } from '../contract/figureInsight'
import { paperInsightRequestSchema } from '../contract/paperInsight'
import { paperBriefSaveSchema } from '../core/paperBrief/contracts'
import { FigureInsightStore } from './figureInsightStore'
import { PaperInsightStore } from './paperInsightStore'

/** Utility handlers of the insight stores; `repository` throws while the database is not ready. */
export function createInsightOperations(repository: () => V2TaskRepositoryCompat) {
  const insightStore = () => new PaperInsightStore(repository())
  const figureInsightStore = () => new FigureInsightStore(repository())
  const handlers: Record<keyof InsightOperations, CoreUtilityOperationHandler> = {
    'figureInsight:get': request => figureInsightStore().get(figureInsightRequestSchema.parse(request.payload)),
    'compute:figure-insight-descriptor': (request, signal) => figureInsightStore().descriptor(figureInsightRequestSchema.parse(request.payload), signal),
    'figureInsight:save': request => figureInsightStore().save(figureInsightSaveSchema.parse(request.payload)),
    'insight:get': (request) => insightStore().get(paperInsightRequestSchema.parse(request.payload).documentId),
    'insight:save-brief': (request) => { const { documentId, brief, anchors } = paperBriefSaveSchema.parse(request.payload); return insightStore().saveBrief(documentId, brief, anchors) },
    'insight:brief-source': (request) => insightStore().briefSource(paperInsightRequestSchema.parse(request.payload).documentId)
  }
  return { handlers, insightStore, figureInsightStore }
}
