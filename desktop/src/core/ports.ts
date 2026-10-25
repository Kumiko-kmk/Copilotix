import type { CopilotixTask } from '@shared/types'
import type {
  TranslationPlanFinalizeResult,
  TranslationPlanListResult,
  TranslationPlanMutationResult,
  TranslationPlanOpenResult
} from '@shared/translationPlanProtocol'

/**
 * Ports shared by Main and Utility. Only contracts with a production
 * implementation live here; the job repository port lives in `./jobs`.
 */
export interface NormalizeParserOutputResult {
  normalized: true
  displayTitle: string | null
  pageCount: number
}

export interface TaskComputePort {
  hashFile(path: string): Promise<string>
  importPdf(sourcePath: string, documentId: string, options?: { skipFirstPage?: boolean }): Promise<{ sha256: string; size: number }>
  normalizeParserOutput(task: CopilotixTask, extractedDir: string, jobId?: string): Promise<NormalizeParserOutputResult>
  rebuildMappings(taskId: string, outputDir: string): Promise<void>
  /** Correct fragmented parser lines of a published parse from the PDF text layer. */
  repairTextLayer?(taskId: string): Promise<{ repaired: number; unresolved: number }>
  openTranslationPlan(taskId: string, jobId: string, signal?: AbortSignal): Promise<TranslationPlanOpenResult>
  listTranslationWork(taskId: string, jobId: string, cursor?: number, limit?: number, signal?: AbortSignal): Promise<TranslationPlanListResult>
  tryTranslationCache(
    taskId: string,
    jobId: string,
    unitId: string,
    provider: CopilotixTask['translationProvider'],
    model: string,
    signal?: AbortSignal
  ): Promise<TranslationPlanMutationResult>
  applyTranslation(
    taskId: string,
    jobId: string,
    unitId: string,
    responsePath?: string,
    provider?: CopilotixTask['translationProvider'] | null,
    model?: string | null,
    signal?: AbortSignal
  ): Promise<TranslationPlanMutationResult>
  failTranslation(taskId: string, jobId: string, unitId: string, error?: string, signal?: AbortSignal): Promise<TranslationPlanMutationResult>
  finalizeTranslation(taskId: string, jobId: string, signal?: AbortSignal): Promise<TranslationPlanFinalizeResult>
}

