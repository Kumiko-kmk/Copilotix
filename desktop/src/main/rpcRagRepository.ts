import type {
  CoreOperationPayload,
  CoreOperationResult
} from '@shared/coreRpcSchemas'
import type { UtilitySupervisor } from './utilitySupervisor'

export type RpcKnowledge = CoreOperationResult['knowledge:get']
export type RpcSemanticConsentResult = CoreOperationResult['knowledge:set-semantic-consent']
export type RpcEnsureEmbeddingResult = CoreOperationResult['knowledge:ensure-embed']

/**
 * Main-side facade for the Utility-owned knowledge lifecycle.  Keeping this
 * separate from RpcTaskRepository prevents future chat/search callers from
 * accidentally gaining access to task paths, source text, vectors, or
 * credentials.  No Renderer IPC is registered here in phase 2.
 */
export class RpcRagRepository {
  constructor(private readonly supervisor: UtilitySupervisor) {}

  async getKnowledge(documentId: string): Promise<RpcKnowledge> {
    const payload: CoreOperationPayload['knowledge:get'] = { documentId }
    return this.supervisor.request('knowledge:get', payload)
  }

  async setSemanticConsent(documentId: string, consent: boolean, now?: string): Promise<RpcSemanticConsentResult> {
    const payload: CoreOperationPayload['knowledge:set-semantic-consent'] = {
      documentId,
      consent,
      ...(now === undefined ? {} : { now })
    }
    return this.supervisor.request('knowledge:set-semantic-consent', payload)
  }

  async ensureEmbeddingJob(documentId: string, profileId: string, now?: string): Promise<RpcEnsureEmbeddingResult> {
    const payload: CoreOperationPayload['knowledge:ensure-embed'] = {
      documentId,
      profileId,
      ...(now === undefined ? {} : { now })
    }
    return this.supervisor.request('knowledge:ensure-embed', payload)
  }
}
