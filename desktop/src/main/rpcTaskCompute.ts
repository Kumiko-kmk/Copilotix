import type { CopilotixTask } from '@shared/types'
import type { UtilitySupervisor } from './utilitySupervisor'
import type { NormalizeParserOutputResult, TaskComputePort } from '@core/ports'
import type {
  TranslationPlanFinalizeResult,
  TranslationPlanListResult,
  TranslationPlanMutationResult,
  TranslationPlanOpenResult
} from '@shared/translationPlanProtocol'
import type { TranslationProviderId } from '@shared/types'

/**
 * Compute operations share one FIFO lane in the Utility, and a long paper can
 * keep it busy for minutes. They are cancelled through the job signal, so the
 * default 30 s RPC timeout would only turn queueing into spurious failures.
 */
export const COMPUTE_RPC_TIMEOUT_MS = 10 * 60_000

/** Main-side compute proxy; all heavy file/hash/mapping work remains utility-owned. */
export class RpcTaskCompute implements TaskComputePort {
  constructor(private readonly supervisor: UtilitySupervisor) {}

  async hashFile(path: string): Promise<string> {
    const result = await this.supervisor.request('compute:hash-file', { path }, { timeoutMs: COMPUTE_RPC_TIMEOUT_MS })
    return result.sha256
  }

  async importPdf(sourcePath: string, documentId: string): Promise<{ sha256: string; size: number }> {
    return this.supervisor.request('compute:import-pdf', { sourcePath, documentId }, { timeoutMs: COMPUTE_RPC_TIMEOUT_MS })
  }

  async normalizeParserOutput(task: CopilotixTask, extractedDir: string, jobId?: string): Promise<NormalizeParserOutputResult> {
    return this.supervisor.request('compute:normalize-parser', {
      task,
      extractedDir,
      ...(jobId === undefined ? {} : { jobId })
    }, { timeoutMs: COMPUTE_RPC_TIMEOUT_MS })
  }

  async rebuildMappings(taskId: string, outputDir: string): Promise<void> {
    await this.supervisor.request('compute:rebuild-mappings', { taskId, outputDir }, { timeoutMs: COMPUTE_RPC_TIMEOUT_MS })
  }

  async openTranslationPlan(taskId: string, jobId: string, signal?: AbortSignal): Promise<TranslationPlanOpenResult> {
    return this.supervisor.request('compute:translation-plan-open', { taskId, jobId }, { signal, timeoutMs: COMPUTE_RPC_TIMEOUT_MS })
  }

  async listTranslationWork(taskId: string, jobId: string, cursor?: number, limit?: number, signal?: AbortSignal): Promise<TranslationPlanListResult> {
    return this.supervisor.request('compute:translation-plan-list', {
      taskId,
      jobId,
      ...(cursor === undefined ? {} : { cursor }),
      ...(limit === undefined ? {} : { limit })
    }, { signal, timeoutMs: COMPUTE_RPC_TIMEOUT_MS })
  }

  async tryTranslationCache(
    taskId: string,
    jobId: string,
    unitId: string,
    provider: TranslationProviderId,
    model: string,
    signal?: AbortSignal
  ): Promise<TranslationPlanMutationResult> {
    return this.supervisor.request('compute:translation-plan-cache', { taskId, jobId, unitId, provider, model }, { signal, timeoutMs: COMPUTE_RPC_TIMEOUT_MS })
  }

  async applyTranslation(
    taskId: string,
    jobId: string,
    unitId: string,
    responsePath?: string,
    provider?: TranslationProviderId | null,
    model?: string | null,
    signal?: AbortSignal
  ): Promise<TranslationPlanMutationResult> {
    return this.supervisor.request('compute:translation-plan-apply', {
      taskId,
      jobId,
      unitId,
      ...(responsePath === undefined ? {} : { responsePath }),
      ...(provider === undefined ? {} : { provider }),
      ...(model === undefined ? {} : { model })
    }, { signal, timeoutMs: COMPUTE_RPC_TIMEOUT_MS })
  }

  async failTranslation(taskId: string, jobId: string, unitId: string, error?: string, signal?: AbortSignal): Promise<TranslationPlanMutationResult> {
    return this.supervisor.request('compute:translation-plan-fail', {
      taskId,
      jobId,
      unitId,
      ...(error === undefined ? {} : { error })
    }, { signal, timeoutMs: COMPUTE_RPC_TIMEOUT_MS })
  }

  async finalizeTranslation(taskId: string, jobId: string, signal?: AbortSignal): Promise<TranslationPlanFinalizeResult> {
    return this.supervisor.request('compute:translation-plan-finalize', { taskId, jobId }, { signal, timeoutMs: COMPUTE_RPC_TIMEOUT_MS })
  }
}
