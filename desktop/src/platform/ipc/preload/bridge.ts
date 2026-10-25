import type { IpcRenderer, IpcRendererEvent } from 'electron'
import type { IpcBridge } from '../contract/channels'
import { decodeIpcEvent, decodeIpcResponse } from './ipcClient'

/** Validates every request before it leaves the renderer and every envelope that comes back. */
export function createIpcBridge(ipcRenderer: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>): IpcBridge {
  return {
    async invoke(channel, request) {
      const validatedRequest = channel.request.parse(request)
      const response = await ipcRenderer.invoke(channel.channel, validatedRequest)
      return decodeIpcResponse(response, channel.response)
    },
    subscribe(channel, listener) {
      const handler = (_event: IpcRendererEvent, payload: unknown): void => {
        const value = decodeIpcEvent(payload, channel.payload)
        if (value) listener(value)
      }
      ipcRenderer.on(channel.channel, handler)
      return () => ipcRenderer.removeListener(channel.channel, handler)
    }
  }
}
