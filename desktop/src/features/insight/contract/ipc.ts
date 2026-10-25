import { eventChannel, invokeChannel, type IpcBridge } from '@platform/ipc/contract/channels'
import { voidResponseSchema } from '@platform/ipc/contract/schemas'
import { paperInsightCancelSchema, paperInsightChangedSchema, paperInsightRequestSchema, paperInsightStateSchema, type PaperInsightState } from './paperInsight'
import { figureInsightCancelSchema, figureInsightChangedSchema, figureInsightRequestSchema, figureInsightStateSchema, type FigureInsightRequest, type FigureInsightState } from './figureInsight'

export const paperInsightChannels = {
  get: invokeChannel('paperInsight:get', paperInsightRequestSchema, paperInsightStateSchema),
  generate: invokeChannel('paperInsight:generate', paperInsightRequestSchema, voidResponseSchema),
  cancel: invokeChannel('paperInsight:cancel', paperInsightRequestSchema, paperInsightCancelSchema),
  changed: eventChannel('paperInsight:changed', paperInsightChangedSchema)
}

export const figureInsightChannels = {
  get: invokeChannel('figureInsight:get', figureInsightRequestSchema, figureInsightStateSchema),
  generate: invokeChannel('figureInsight:generate', figureInsightRequestSchema, voidResponseSchema),
  cancel: invokeChannel('figureInsight:cancel', figureInsightRequestSchema, figureInsightCancelSchema),
  changed: eventChannel('figureInsight:changed', figureInsightChangedSchema)
}

export interface PaperInsightDesktopApi {
  get(request: { documentId: string }): Promise<PaperInsightState>
  generate(request: { documentId: string }): Promise<void>
  cancel(request: { documentId: string }): Promise<{ cancelled: boolean }>
  onChanged(listener: (event: { documentId: string; state: PaperInsightState }) => void): () => void
}

export interface FigureInsightDesktopApi {
  get(request: FigureInsightRequest): Promise<FigureInsightState>
  generate(request: FigureInsightRequest): Promise<void>
  cancel(request: FigureInsightRequest): Promise<{ cancelled: boolean }>
  onChanged(listener: (event: FigureInsightRequest & { state: FigureInsightState }) => void): () => void
}

export function createPaperInsightApi(ipc: IpcBridge): PaperInsightDesktopApi {
  return {
    get: request => ipc.invoke(paperInsightChannels.get, request),
    generate: request => ipc.invoke(paperInsightChannels.generate, request),
    cancel: request => ipc.invoke(paperInsightChannels.cancel, request),
    onChanged: listener => ipc.subscribe(paperInsightChannels.changed, listener)
  }
}

export function createFigureInsightApi(ipc: IpcBridge): FigureInsightDesktopApi {
  return {
    get: request => ipc.invoke(figureInsightChannels.get, request),
    generate: request => ipc.invoke(figureInsightChannels.generate, request),
    cancel: request => ipc.invoke(figureInsightChannels.cancel, request),
    onChanged: listener => ipc.subscribe(figureInsightChannels.changed, listener)
  }
}
