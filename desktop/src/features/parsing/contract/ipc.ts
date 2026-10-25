import { invokeChannel, type IpcBridge } from '@platform/ipc/contract/channels'
import {
  cacheDocumentFigureRequestSchema,
  cacheDocumentFigureResultSchema,
  documentIdRequestSchema,
  repairTextLayerResultSchema,
  type CacheDocumentFigureRequest,
  type CacheDocumentFigureResult,
  type RepairTextLayerResult
} from '@shared/ipcSchemas'

export const parsingChannels = {
  cacheFigure: invokeChannel('documents:cache-figure', cacheDocumentFigureRequestSchema, cacheDocumentFigureResultSchema),
  repairTextLayer: invokeChannel('documents:repair-text-layer', documentIdRequestSchema, repairTextLayerResultSchema)
}

export interface ParsingDesktopApi {
  cacheDocumentFigure?(request: CacheDocumentFigureRequest): Promise<CacheDocumentFigureResult>
  repairDocumentTextLayer(documentId: string): Promise<RepairTextLayerResult>
}

export function createParsingApi(ipc: IpcBridge): ParsingDesktopApi {
  return {
    repairDocumentTextLayer: documentId => ipc.invoke(parsingChannels.repairTextLayer, documentId),
    cacheDocumentFigure: request => ipc.invoke(parsingChannels.cacheFigure, request)
  }
}
