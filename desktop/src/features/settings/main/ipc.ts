import { mkdir } from 'node:fs/promises'
import type { IpcRegistrar } from '@platform/ipc/main/ipc'
import type { SettingsService } from '@main/settingsService'
import type { UsageAnalyticsService } from '@main/usageAnalyticsService'
import { inspectStorage } from '@main/storageService'
import type { CopilotixTask, SettingsSaveResult, SettingsUpdate, AppSettings } from '@shared/types'
import { settingsChannels } from '../contract/ipc'

export interface SettingsIpcDeps {
  settings: SettingsService
  usageAnalytics: UsageAnalyticsService
  listTasks(): Promise<CopilotixTask[]>
  /** Lets the features whose model or credentials changed cancel their running work. */
  afterSave(before: AppSettings, update: SettingsUpdate, result: SettingsSaveResult): void
  chooseDirectory(): Promise<string | null>
  openPath(path: string): Promise<string>
}

export function registerSettingsIpc(ipc: IpcRegistrar, deps: SettingsIpcDeps): void {
  const { settings } = deps
  ipc.handle(settingsChannels.get, () => settings.get())
  ipc.handle(settingsChannels.save, async (_event, update) => {
    const before = await settings.get()
    const result = await settings.save(update)
    deps.afterSave(before, update, result)
    return result
  })
  ipc.handle(settingsChannels.validateCredential, (_event, request) => settings.validateCredential(request.name, request.value))
  ipc.handle(settingsChannels.chooseOutputDirectory, () => deps.chooseDirectory())
  ipc.handle(settingsChannels.storageInfo, async () => {
    const current = await settings.get()
    return inspectStorage(current.outputRoot)
  })
  ipc.handle(settingsChannels.usageAnalytics, async () => {
    return deps.usageAnalytics.snapshot(await deps.listTasks())
  })
  ipc.handle(settingsChannels.openStorageLocation, async () => {
    const current = await settings.get()
    await mkdir(current.outputRoot, { recursive: true })
    const result = await deps.openPath(current.outputRoot)
    if (result) throw new Error(result)
  })
}
