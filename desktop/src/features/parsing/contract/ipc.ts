import { invokeChannel, type IpcBridge } from '@platform/ipc/contract/channels'
import { documentIdRequestSchema } from '@features/library/contract/documentSchemas'
import { repairTextLayerResultSchema, type RepairTextLayerResult } from './blockSchemas'

export const parsingChannels = {
  repairTextLayer: invokeChannel('documents:repair-text-layer', documentIdRequestSchema, repairTextLayerResultSchema)
}

export interface ParsingDesktopApi {
  repairDocumentTextLayer(documentId: string): Promise<RepairTextLayerResult>
}

export function createParsingApi(ipc: IpcBridge): ParsingDesktopApi {
  return {
    repairDocumentTextLayer: documentId => ipc.invoke(parsingChannels.repairTextLayer, documentId)
  }
}
