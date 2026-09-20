import type { CoreOperationPayload, CoreOperationResult } from '@shared/coreRpcSchemas'
import type { UtilitySupervisor } from './utilitySupervisor'

export type RpcRagContentIndexResult = CoreOperationResult['compute:rag-content-index']

/** Main facade carrying only bounded revision identifiers across Core RPC. */
export class RpcRagContentIndexer {
  constructor(private readonly supervisor: UtilitySupervisor) {}

  index(documentId: string, contentRevisionId: string, signal?: AbortSignal): Promise<RpcRagContentIndexResult> {
    const payload: CoreOperationPayload['compute:rag-content-index'] = { documentId, contentRevisionId }
    return this.supervisor.request('compute:rag-content-index', payload, { signal })
  }
}
