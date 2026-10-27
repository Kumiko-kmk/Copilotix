import { eventChannel, invokeChannel, type IpcBridge } from '@platform/ipc/contract/channels'
import { voidResponseSchema } from '@platform/ipc/contract/schemas'
import { paperInsightCancelSchema, paperInsightChangedSchema, paperInsightReadRequestSchema, paperInsightRequestSchema, paperInsightStateSchema, type PaperInsightState } from './paperInsight'
import { archiveCoverSourceRequestSchema, archiveCoverSourceSchema, figureInsightCancelSchema, figureInsightChangedSchema, figureInsightRequestSchema, figureInsightStateSchema, type ArchiveCoverSource, type FigureInsightRequest, type FigureInsightState } from './figureInsight'
import { archiveInsightListRequestSchema, archiveInsightListResultSchema, type ArchiveInsightSnapshot } from './archiveInsight'

export const paperInsightChannels = {
  get: invokeChannel('paperInsight:get', paperInsightReadRequestSchema, paperInsightStateSchema),
  list: invokeChannel('paperInsight:list', archiveInsightListRequestSchema, archiveInsightListResultSchema),
  generate: invokeChannel('paperInsight:generate', paperInsightRequestSchema, voidResponseSchema),
  cancel: invokeChannel('paperInsight:cancel', paperInsightRequestSchema, paperInsightCancelSchema),
  changed: eventChannel('paperInsight:changed', paperInsightChangedSchema)
}

export const figureInsightChannels = {
  get: invokeChannel('figureInsight:get', figureInsightRequestSchema, figureInsightStateSchema),
  coverSource: invokeChannel('figureInsight:cover-source', archiveCoverSourceRequestSchema, archiveCoverSourceSchema),
  generate: invokeChannel('figureInsight:generate', figureInsightRequestSchema, voidResponseSchema),
  cancel: invokeChannel('figureInsight:cancel', figureInsightRequestSchema, figureInsightCancelSchema),
  changed: eventChannel('figureInsight:changed', figureInsightChangedSchema)
}

export interface PaperInsightDesktopApi {
  get(request: { documentId: string; savedOnly?: true }): Promise<PaperInsightState>
  list?(request: { documentIds: readonly string[] }): Promise<ArchiveInsightSnapshot[]>
  generate(request: { documentId: string }): Promise<void>
  cancel(request: { documentId: string }): Promise<{ cancelled: boolean }>
  onChanged(listener: (event: { documentId: string; state: PaperInsightState }) => void): () => void
}

export interface FigureInsightDesktopApi {
  get(request: FigureInsightRequest): Promise<FigureInsightState>
  coverSource?(request: { documentId: string }): Promise<ArchiveCoverSource>
  generate(request: FigureInsightRequest): Promise<void>
  cancel(request: FigureInsightRequest): Promise<{ cancelled: boolean }>
  onChanged(listener: (event: FigureInsightRequest & { state: FigureInsightState }) => void): () => void
}

export function createPaperInsightApi(ipc: IpcBridge): PaperInsightDesktopApi {
  return {
    get: request => ipc.invoke(paperInsightChannels.get, request),
    list: request => ipc.invoke(paperInsightChannels.list, { documentIds: [...request.documentIds] }),
    generate: request => ipc.invoke(paperInsightChannels.generate, request),
    cancel: request => ipc.invoke(paperInsightChannels.cancel, request),
    onChanged: listener => ipc.subscribe(paperInsightChannels.changed, listener)
  }
}

export function createFigureInsightApi(ipc: IpcBridge): FigureInsightDesktopApi {
  return {
    get: request => ipc.invoke(figureInsightChannels.get, request),
    coverSource: request => ipc.invoke(figureInsightChannels.coverSource, request),
    generate: request => ipc.invoke(figureInsightChannels.generate, request),
    cancel: request => ipc.invoke(figureInsightChannels.cancel, request),
    onChanged: listener => ipc.subscribe(figureInsightChannels.changed, listener)
  }
}
