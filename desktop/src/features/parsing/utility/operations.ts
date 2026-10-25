import type { CoreUtilityOperationHandler } from '@platform/rpc/utility/coreUtilityRuntime'
import type { CopilotixTask } from '@shared/types'
import type { V2TaskRepositoryCompat } from '../../../utility/core/persistence/v2TaskRepositoryCompat'
import { coreRepairTextLayerPayloadSchema, type ParsingOperations } from '../contract/rpc'
import { normalizeParserOutput, rebuildMappings, repairParsedTextLayer } from './parserOutput'

/** Utility handlers of parsing; `repository` throws while the database is not ready. */
export function createParsingOperations(repository: () => V2TaskRepositoryCompat) {
  const handlers: Record<keyof ParsingOperations, CoreUtilityOperationHandler> = {
    'compute:normalize-parser': async (request, signal) => {
      const payload = request.payload as { task: CopilotixTask; extractedDir: string; jobId?: string }
      return normalizeParserOutput(payload.task, payload.extractedDir, repository(), payload.jobId, signal)
    },
    'compute:repair-text-layer': async (request, signal) => {
      const payload = coreRepairTextLayerPayloadSchema.parse(request.payload)
      return repairParsedTextLayer(payload.taskId, repository(), signal)
    },
    'compute:rebuild-mappings': async (request) => {
      const payload = request.payload as { taskId: string; outputDir: string }
      await rebuildMappings(payload.taskId, payload.outputDir, repository())
      return { rebuilt: true }
    }
  }
  return { handlers }
}
