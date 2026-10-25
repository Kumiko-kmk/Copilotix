import { invokeChannel, type IpcBridge } from '@platform/ipc/contract/channels'
import { noRequestSchema, outputDirectorySchema } from '@platform/ipc/contract/schemas'
import { codexProbeSchema, codexStatusSchema, type CodexApi } from './codex'

export const codexChannels = {
  cached: invokeChannel('codex:cached', codexProbeSchema.shape.settings, codexStatusSchema.nullable()),
  inspect: invokeChannel('codex:inspect', codexProbeSchema, codexStatusSchema),
  selectExecutable: invokeChannel('codex:select-executable', noRequestSchema, outputDirectorySchema)
}

export function createCodexApi(ipc: IpcBridge): CodexApi {
  return {
    cached: settings => ipc.invoke(codexChannels.cached, settings),
    inspect: request => ipc.invoke(codexChannels.inspect, request),
    selectExecutable: () => ipc.invoke(codexChannels.selectExecutable, undefined)
  }
}
