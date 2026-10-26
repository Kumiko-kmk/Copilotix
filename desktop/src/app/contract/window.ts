import { eventChannel, invokeChannel, type IpcBridge } from '@platform/ipc/contract/channels'
import { noRequestSchema } from '@platform/ipc/contract/schemas'
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
  stateChanged: eventChannel('window:state-changed', windowStateSchema)
}

export interface WindowDesktopApi {
  performWindowAction(action: WindowAction): Promise<WindowState>
  getWindowState(): Promise<WindowState>
  onWindowStateChanged(listener: (state: WindowState) => void): () => void
}

export function createWindowApi(ipc: IpcBridge): WindowDesktopApi {
  return {
    performWindowAction: action => ipc.invoke(windowChannels.action, action),
    getWindowState: () => ipc.invoke(windowChannels.state, undefined),
    onWindowStateChanged: listener => ipc.subscribe(windowChannels.stateChanged, listener)
  }
}
