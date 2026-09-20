import type { JobRunner, JobRunnerInput, JobRunnerResult } from '@core/jobs'
import { JobRunnerError } from '@core/jobs'
import type { RpcRagContentIndexer } from './rpcRagContentIndexer'

/** Executes the local AST chunking phase; all file/SQLite work stays Utility-owned. */
export class RagContentIndexJobRunner implements JobRunner {
  constructor(private readonly indexer: Pick<RpcRagContentIndexer, 'index'>) {}

  async run(input: JobRunnerInput): Promise<JobRunnerResult> {
    const revisionId = readRevisionId(input.job.payload)
    if (!revisionId) throw new JobRunnerError('内容版本标识缺失', 'RAG_CONTENT_REVISION_REQUIRED', false)
    if (input.signal.aborted) throw abortError()
    await input.updateProgress(20, { ...input.job.checkpoint, phase: 'chunking', contentRevisionId: revisionId })
    try {
      const result = await this.indexer.index(input.job.documentId, revisionId, input.signal)
      if (input.signal.aborted) throw abortError()
      return {
        status: 'succeeded',
        progress: 100,
        checkpoint: { ...input.job.checkpoint, phase: 'published', contentRevisionId: revisionId, chunkCount: result.chunkCount },
        detail: { contentRevisionId: revisionId, chunkCount: result.chunkCount }
      }
    } catch (error) {
      if (isAbort(error) || input.signal.aborted) throw abortError()
      if (error instanceof JobRunnerError) throw error
      if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string' && typeof (error as { retryable?: unknown }).retryable === 'boolean') {
        const typed = error as { code: string; retryable: boolean; message?: string }
        throw new JobRunnerError(typed.message ?? '内容索引失败', typed.code, typed.retryable)
      }
      throw new JobRunnerError(error instanceof Error ? error.message : '内容索引失败', 'RAG_CONTENT_INDEX_FAILED', false)
    }
  }
}

function readRevisionId(payload: Record<string, unknown>): string | null {
  const value = payload.contentRevisionId
  return typeof value === 'string' && value.length > 0 ? value : null
}

function abortError(): Error { return new Error('RAG_CONTENT_INDEX_CANCELLED') }
function isAbort(error: unknown): boolean { return error instanceof Error && error.message === 'RAG_CONTENT_INDEX_CANCELLED' }
