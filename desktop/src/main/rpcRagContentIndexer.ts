import type { CoreOperationPayload, CoreOperationResult } from '@app/contract/coreRpc'
import { COMPUTE_RPC_TIMEOUT_MS } from './rpcTaskCompute'
import type { AppCoreRequester } from '@app/contract/coreRpc'

export type RpcRagContentIndexResult = CoreOperationResult['compute:rag-content-index']

/** Main facade carrying only bounded revision identifiers across Core RPC. */
export class RpcRagContentIndexer {
  constructor(private readonly supervisor: AppCoreRequester) {}

  index(documentId: string, contentRevisionId: string, signal?: AbortSignal): Promise<RpcRagContentIndexResult> {
    const payload: CoreOperationPayload['compute:rag-content-index'] = { documentId, contentRevisionId }
    return this.supervisor.request('compute:rag-content-index', payload, { signal, timeoutMs: COMPUTE_RPC_TIMEOUT_MS })
  }
}
