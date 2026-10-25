import type { IpcRegistrar } from '@platform/ipc/main/ipc'
import type { CodexRuntime } from '../runtime/codexRuntime'
import { codexChannels } from '../contract/ipc'

export function registerCodexIpc(ipc: IpcRegistrar, deps: {
  codex(): CodexRuntime
  /** Native file picker for codex.exe; null when cancelled. */
  chooseExecutable(): Promise<string | null>
}): void {
  ipc.handle(codexChannels.cached, (_event, request) => deps.codex().cached(request))
  ipc.handle(codexChannels.inspect, (_event, request) => deps.codex().inspect(request.settings, request.testModel))
  ipc.handle(codexChannels.selectExecutable, () => deps.chooseExecutable())
}
