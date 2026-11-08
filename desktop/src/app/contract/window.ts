import { eventChannel, invokeChannel, type IpcBridge } from '@platform/ipc/contract/channels'
import { noRequestSchema, voidResponseSchema } from '@platform/ipc/contract/schemas'
import { z } from 'zod'

export type WindowAction = 'minimize' | 'toggle-maximize' | 'close'

export interface WindowState {
  maximized: boolean
}

export const windowActionSchema = z.enum(['minimize', 'toggle-maximize', 'close'])
export const windowStateSchema: z.ZodType<WindowState> = z.object({ maximized: z.boolean() }).strict()

export const windowChannels = {
  state: invokeChannel('window:state', noRequestSchema, windowStateSchema),
  action: invokeChannel('window:action', windowActionSchema, windowStateSchema),
  stateChanged: eventChannel('window:state-changed', windowStateSchema),
  /** Opens a paper in a window of its own. */
  openDocument: invokeChannel('window:open-document', z.uuid(), voidResponseSchema),
  /** The paper a window opened by `openDocument` was opened for; null for the main window. */
  initialDocument: invokeChannel('window:initial-document', noRequestSchema, z.uuid().nullable())
}

export interface WindowDesktopApi {
  performWindowAction(action: WindowAction): Promise<WindowState>
  getWindowState(): Promise<WindowState>
  onWindowStateChanged(listener: (state: WindowState) => void): () => void
  openDocumentWindow(documentId: string): Promise<void>
  initialDocument(): Promise<string | null>
}

export function createWindowApi(ipc: IpcBridge): WindowDesktopApi {
  return {
    performWindowAction: action => ipc.invoke(windowChannels.action, action),
    getWindowState: () => ipc.invoke(windowChannels.state, undefined),
    onWindowStateChanged: listener => ipc.subscribe(windowChannels.stateChanged, listener),
    openDocumentWindow: documentId => ipc.invoke(windowChannels.openDocument, documentId),
    initialDocument: () => ipc.invoke(windowChannels.initialDocument, undefined)
  }
}
