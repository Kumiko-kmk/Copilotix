import type { CorePayloadOf, CoreRequester, CoreResultOf } from '@platform/rpc/contract/protocol'
import type { ChatOperations } from '../contract/rpc'
import { COMPUTE_RPC_TIMEOUT_MS } from '@features/library/main'

export type RpcRagContentIndexResult = CoreResultOf<ChatOperations, 'compute:rag-content-index'>

/** Main facade carrying only bounded revision identifiers across Core RPC. */
export class RpcRagContentIndexer {
  constructor(private readonly supervisor: CoreRequester<ChatOperations>) {}

  index(documentId: string, contentRevisionId: string, signal?: AbortSignal): Promise<RpcRagContentIndexResult> {
    const payload: CorePayloadOf<ChatOperations, 'compute:rag-content-index'> = { documentId, contentRevisionId }
    return this.supervisor.request('compute:rag-content-index', payload, { signal, timeoutMs: COMPUTE_RPC_TIMEOUT_MS })
  }
}
