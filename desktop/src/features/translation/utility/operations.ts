import type { CoreUtilityOperationHandler } from '@platform/rpc/utility/coreUtilityRuntime'
import {
  coreTranslationPlanApplyPayloadSchema,
  coreTranslationPlanCachePayloadSchema,
  coreTranslationPlanFailPayloadSchema,
  coreTranslationPlanFinalizePayloadSchema,
  coreTranslationPlanListPayloadSchema,
  coreTranslationPlanOpenPayloadSchema,
  type TranslationOperations
} from '../contract/rpc'
import type { MarkdownTranslationPlanManager } from './markdownTranslationPlan'

/** Utility handlers of the translation plan; `plans` throws while the database is not ready. */
export function createTranslationOperations(plans: () => MarkdownTranslationPlanManager) {
  const handlers: Record<keyof TranslationOperations, CoreUtilityOperationHandler> = {
    'compute:translation-plan-open': async (request) => {
      const payload = coreTranslationPlanOpenPayloadSchema.parse(request.payload)
      return plans().open(payload.taskId, payload.jobId)
    },
    'compute:translation-plan-list': async (request) => {
      const payload = coreTranslationPlanListPayloadSchema.parse(request.payload)
      return plans().listWork(payload.taskId, payload.jobId, payload.cursor, payload.limit)
    },
    'compute:translation-plan-cache': async (request) => {
      const payload = coreTranslationPlanCachePayloadSchema.parse(request.payload)
      return plans().tryCache(payload.taskId, payload.jobId, payload.unitId, payload.provider, payload.model)
    },
    'compute:translation-plan-apply': async (request) => {
      const payload = coreTranslationPlanApplyPayloadSchema.parse(request.payload)
      return plans().apply(
        payload.taskId,
        payload.jobId,
        payload.unitId,
        payload.responsePath,
        payload.provider ?? null,
        payload.model ?? null
      )
    },
    'compute:translation-plan-fail': async (request) => {
      const payload = coreTranslationPlanFailPayloadSchema.parse(request.payload)
      return plans().fail(payload.taskId, payload.jobId, payload.unitId, payload.error)
    },
    'compute:translation-plan-finalize': async (request) => {
      const payload = coreTranslationPlanFinalizePayloadSchema.parse(request.payload)
      return plans().finalize(payload.taskId, payload.jobId)
    }
  }
  return { handlers }
}
