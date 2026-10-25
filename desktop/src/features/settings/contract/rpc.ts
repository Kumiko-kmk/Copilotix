import { z } from 'zod'
import { appSettingsSchema } from '@shared/ipcSchemas'
import { coreIdSchema, corePathSchema } from '@platform/rpc/contract/protocol'

export const coreSettingsGetPayloadSchema = z.object({ outputRoot: corePathSchema }).strict()
export const coreSettingsGetResultSchema = appSettingsSchema
export const coreSettingsSavePayloadSchema = z.object({ settings: appSettingsSchema }).strict()
export const coreSettingsSaveResultSchema = appSettingsSchema
export const coreSettingsMigrationPayloadSchema = z.object({ id: coreIdSchema }).strict()
export const coreSettingsMigrationGetResultSchema = z.object({ applied: z.boolean() }).strict()
export const coreSettingsMigrationMarkResultSchema = z.object({ applied: z.literal(true) }).strict()

/** Core RPC operations persisting settings in the Utility database (credentials stay in the platform vault). */
export const settingsOperations = {
  'settings:get': { payload: coreSettingsGetPayloadSchema, result: coreSettingsGetResultSchema },
  'settings:save': { payload: coreSettingsSavePayloadSchema, result: coreSettingsSaveResultSchema },
  'settings:migration-get': { payload: coreSettingsMigrationPayloadSchema, result: coreSettingsMigrationGetResultSchema },
  'settings:migration-mark': { payload: coreSettingsMigrationPayloadSchema, result: coreSettingsMigrationMarkResultSchema }
} as const
export type SettingsOperations = typeof settingsOperations
