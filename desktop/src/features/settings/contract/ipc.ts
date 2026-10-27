import { invokeChannel, type IpcBridge } from '@platform/ipc/contract/channels'
import { noRequestSchema, outputDirectorySchema, voidResponseSchema } from '@platform/ipc/contract/schemas'
import {
  appSettingsSchema,
  credentialValidationRequestSchema,
  credentialValidationResultSchema,
  settingsSaveResultSchema,
  settingsUpdateSchema,
  storageInfoSchema,
  usageAnalyticsSchema,
  type StorageInfo,
  type UsageAnalytics
} from './settingsSchemas'
import type { AppSettings, CredentialName, CredentialValidationResult, SettingsSaveResult, SettingsUpdate } from './settingsTypes'

export const settingsChannels = {
  get: invokeChannel('settings:get', noRequestSchema, appSettingsSchema),
  save: invokeChannel('settings:save', settingsUpdateSchema, settingsSaveResultSchema),
  validateCredential: invokeChannel('settings:validate-credential', credentialValidationRequestSchema, credentialValidationResultSchema),
  chooseOutputDirectory: invokeChannel('dialog:output-directory', noRequestSchema, outputDirectorySchema),
  storageInfo: invokeChannel('storage:info', noRequestSchema, storageInfoSchema),
  usageAnalytics: invokeChannel('analytics:usage', noRequestSchema, usageAnalyticsSchema),
  openStorageLocation: invokeChannel('storage:open-location', noRequestSchema, voidResponseSchema)
}

export interface SettingsDesktopApi {
  getSettings(): Promise<AppSettings>
  saveSettings(update: SettingsUpdate): Promise<SettingsSaveResult>
  validateCredential(name: CredentialName, value?: string): Promise<CredentialValidationResult>
  chooseOutputDirectory(): Promise<string | null>
  getStorageInfo(): Promise<StorageInfo>
  getUsageAnalytics(): Promise<UsageAnalytics>
  openStorageLocation(): Promise<void>
}

export function createSettingsApi(ipc: IpcBridge): SettingsDesktopApi {
  return {
    getSettings: () => ipc.invoke(settingsChannels.get, undefined),
    saveSettings: update => ipc.invoke(settingsChannels.save, update),
    validateCredential: (name, value) => ipc.invoke(settingsChannels.validateCredential, { name, value }),
    chooseOutputDirectory: () => ipc.invoke(settingsChannels.chooseOutputDirectory, undefined),
    getStorageInfo: () => ipc.invoke(settingsChannels.storageInfo, undefined),
    getUsageAnalytics: () => ipc.invoke(settingsChannels.usageAnalytics, undefined),
    openStorageLocation: () => ipc.invoke(settingsChannels.openStorageLocation, undefined)
  }
}
