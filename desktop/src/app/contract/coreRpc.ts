import { createCoreProtocol, platformOperations, type CoreMessageOf, type CoreOperationOf, type CorePayloadOf, type CoreRequestOf, type CoreRequester, type CoreResultOf, type CoreResponse } from '@platform/rpc/contract/protocol'
import { jobOperations } from '@platform/jobs/contract/rpc'
import { readerOperations } from '@features/reader/contract/rpc'
import { libraryOperations } from '@features/library/contract/rpc'
import { settingsOperations } from '@features/settings/contract/rpc'
import { parsingOperations } from '@features/parsing/contract/rpc'
import { insightOperations } from '@features/insight/contract/rpc'
import { chatOperations } from '@features/chat/contract/rpc'
import { translationOperations } from '@features/translation/contract/rpc'

/**
 * The complete Core RPC registry, the only source of operation payload/result
 * types. Operations are declared next to their owner and combined here; Main
 * and Utility receive the bound protocol instead of importing this file.
 */
export const coreOperationRegistry = { ...platformOperations, ...jobOperations, ...insightOperations, ...chatOperations, ...translationOperations, ...parsingOperations, ...settingsOperations, ...libraryOperations, ...readerOperations } as const
export type CoreOperationRegistryShape = typeof coreOperationRegistry

export const coreProtocol = createCoreProtocol(coreOperationRegistry)

export type CoreOperation = CoreOperationOf<CoreOperationRegistryShape>
export type CoreOperationPayload = { [K in CoreOperation]: CorePayloadOf<CoreOperationRegistryShape, K> }
export type CoreOperationResult = { [K in CoreOperation]: CoreResultOf<CoreOperationRegistryShape, K> }
export type CoreRequest = CoreRequestOf<CoreOperationRegistryShape>
export type CoreMessage = CoreMessageOf<CoreOperationRegistryShape>

export const coreOperationSchema = coreProtocol.operationSchema
export const coreRequestSchema = coreProtocol.requestSchema
export const coreMessageSchema = coreProtocol.messageSchema
export const serializeCoreMessage = (rawMessage: unknown): string => coreProtocol.serializeMessage(rawMessage)
export const deserializeCoreMessage = (rawMessage: unknown): CoreMessage => coreProtocol.deserializeMessage(rawMessage)
export function validateCoreOperationResult<K extends CoreOperation>(operation: K, value: unknown): CoreOperationResult[K] {
  return coreProtocol.validateResult(operation, value) as CoreOperationResult[K]
}
export function makeCoreSuccessResponse<K extends CoreOperation>(requestId: string, operation: K, value: CoreOperationResult[K]): CoreResponse {
  return coreProtocol.makeSuccessResponse(requestId, operation, value)
}

/** The utility request surface for code that still spans several modules (removed per module in M4). */
export type AppCoreRequester = CoreRequester<CoreOperationRegistryShape>
