import { codexSettingsSchema, DEFAULT_CODEX_SETTINGS } from '@platform/codex/contract/codex'
import { paperChatProviderSchema, qwenChatModelSchema, deepseekChatModelSchema } from '@features/chat/contract/paperChatSchemas'
import { z } from 'zod'
import { connectionIdSchema, defaultConnections, modelConnectionsSchema } from '@platform/models/contract/models'
import { boundedPath, hasControlCharacters, noNul } from '@platform/ipc/contract/validation'
import type { AppSettings, CredentialFieldError, CredentialMutation, CredentialName, CredentialStatus, CredentialStatuses, CredentialValidationResult, KeyStatus, SettingsUpdate, SettingsSaveResult } from './settingsTypes'
const activeProviderSchema = z.enum(['qwen', 'deepseek', 'codex'])

/** IPC schemas for settings, credentials, storage and usage analytics. */

export const credentialNameSchema: z.ZodType<CredentialName> = z.enum(['parser', 'qwen', 'deepseek'])

export const credentialValueSchema = z.string()
  .trim()
  .min(1, '憑據不能為空')
  .max(16_384, '憑據過長')
  .refine(noNul, '憑據不能包含 NUL 字元')
  .refine((value) => !hasControlCharacters(value), '憑據不能包含控制字元')

export const credentialMutationSchema: z.ZodType<CredentialMutation> = z.union([
  z.object({ action: z.literal('set'), value: credentialValueSchema }).strict(),
  z.object({ action: z.literal('clear') }).strict()
])

export const credentialStatusesSchema: z.ZodType<CredentialStatuses> = z.object({
  parser: credentialStatusSchemaPlaceholder(),
  qwen: credentialStatusSchemaPlaceholder(),
  deepseek: credentialStatusSchemaPlaceholder()
}).strict()

export const translationProviderOrderSchema = z.array(activeProviderSchema).length(3).refine(
  (providers) => new Set(providers).size === providers.length,
  '翻譯模型順序必須完整且不能重複'
)

export const enabledTranslationProvidersSchema = z.array(activeProviderSchema).max(3).refine(
  (providers) => new Set(providers).size === providers.length,
  '啟用的翻譯模型不能重複'
)

export function credentialStatusSchemaPlaceholder(): z.ZodType<CredentialStatus> {
  return z.object({
    state: z.enum(['missing', 'unknown', 'valid', 'invalid']),
    maskedValue: z.string().max(256).refine(noNul).optional(),
    errorCode: z.string().max(128).refine(noNul).optional(),
    message: z.string().max(1_024).refine(noNul).optional()
  }).strict()
}

export const keyStatusSchema: z.ZodType<KeyStatus> = z.object({
  state: z.enum(['missing', 'unknown', 'valid', 'invalid']),
  maskedValue: z.string().max(256).refine(noNul).optional(),
  errorCode: z.string().max(128).refine(noNul).optional(),
  message: z.string().max(1_024).refine(noNul).optional(),
  health: z.enum(['cooldown', 'rejected']).optional(),
  retryAt: z.number().int().nonnegative().optional()
}).strict()

const keyRecord = <T extends z.ZodTypeAny>(value: T) => z.record(connectionIdSchema, value).refine(record => Object.keys(record).length <= 16, '金鑰數量超出上限')

export const credentialFieldErrorSchema: z.ZodType<CredentialFieldError> = z.object({
  code: z.string().min(1).max(128).refine(noNul),
  message: z.string().min(1).max(1_024).refine(noNul)
}).strict()

export const credentialValidationResultSchema: z.ZodType<CredentialValidationResult> = z.object({
  state: z.enum(['missing', 'unknown', 'valid', 'invalid']),
  errorCode: z.string().max(128).refine(noNul).optional(),
  message: z.string().max(1_024).refine(noNul).optional()
}).strict()

export const credentialValidationRequestSchema = z.object({
  name: credentialNameSchema,
  value: credentialValueSchema.optional(),
  /** A saved model key to check; without it qwen/deepseek mean their default key. */
  connectionId: connectionIdSchema.optional()
}).strict()

export const appSettingsSchema: z.ZodType<AppSettings> = z.object({
  modelConnections: modelConnectionsSchema.default(defaultConnections),
  outputRoot: boundedPath,
  formulaEnabled: z.boolean(),
  tableEnabled: z.boolean(),
  translationProvider: activeProviderSchema.nullable(),
  translationProviderOrder: translationProviderOrderSchema,
  enabledTranslationProviders: enabledTranslationProvidersSchema,
  codex: codexSettingsSchema.default(DEFAULT_CODEX_SETTINGS),
  qwenBaseUrl: z.string().min(1).max(2_048),
  qwenModel: z.string().min(1).max(512),
  deepseekBaseUrl: z.string().min(1).max(2_048),
  deepseekModel: z.string().min(1).max(512),
  autoGeneratePaperInsight: z.boolean().default(true),
  chatProvider: paperChatProviderSchema.nullable().default(null),
  qwenChatModel: qwenChatModelSchema.default('qwen-plus').catch('qwen-plus'),
  deepseekChatModel: deepseekChatModelSchema.default('deepseek-flash').catch('deepseek-flash'),
  chatConsentProvider: paperChatProviderSchema.nullable().default(null),
  chatConsentVersion: z.number().int().min(1).max(1000).nullable().default(null),
  credentials: credentialStatusesSchema,
  keyStatuses: keyRecord(keyStatusSchema).optional()
}).strict().refine(
  (settings) => (settings.translationProviderOrder.find((provider) => settings.enabledTranslationProviders.includes(provider)) ?? null) === settings.translationProvider,
  '首選翻譯模型必須是順序中第一個已啟用模型'
)

export const settingsUpdateSchema: z.ZodType<SettingsUpdate> = z.object({
  modelConnections: modelConnectionsSchema.optional(),
  outputRoot: boundedPath,
  formulaEnabled: z.boolean(),
  tableEnabled: z.boolean(),
  translationProvider: activeProviderSchema.nullable(),
  translationProviderOrder: translationProviderOrderSchema,
  enabledTranslationProviders: enabledTranslationProvidersSchema,
  codex: codexSettingsSchema.default(DEFAULT_CODEX_SETTINGS),
  qwenBaseUrl: z.string().min(1).max(2_048),
  qwenModel: z.string().min(1).max(512),
  deepseekBaseUrl: z.string().min(1).max(2_048),
  deepseekModel: z.string().min(1).max(512),
  autoGeneratePaperInsight: z.boolean().default(true),
  chatProvider: paperChatProviderSchema.nullable().default(null),
  qwenChatModel: qwenChatModelSchema.default('qwen-plus'),
  deepseekChatModel: deepseekChatModelSchema.default('deepseek-flash'),
  chatConsentProvider: paperChatProviderSchema.nullable().default(null),
  chatConsentVersion: z.number().int().min(1).max(1000).nullable().default(null),
  credentialMutations: z.object({
    parser: credentialMutationSchema.optional(),
    qwen: credentialMutationSchema.optional(),
    deepseek: credentialMutationSchema.optional()
  }).strict().optional(),
  keyMutations: keyRecord(credentialMutationSchema).optional(),
  /** Derived on read; callers that spread getSettings() may send it back, and it is dropped here. */
  keyStatuses: z.unknown().optional().transform(() => undefined)
}).strict().refine(
  (settings) => (settings.translationProviderOrder.find((provider) => settings.enabledTranslationProviders.includes(provider)) ?? null) === settings.translationProvider,
  '首選翻譯模型必須是順序中第一個已啟用模型'
)

export const settingsSaveResultSchema: z.ZodType<SettingsSaveResult> = z.object({
  settings: appSettingsSchema,
  fieldErrors: z.object({
    parser: credentialFieldErrorSchema.optional(),
    qwen: credentialFieldErrorSchema.optional(),
    deepseek: credentialFieldErrorSchema.optional()
  }).strict(),
  keyErrors: keyRecord(credentialFieldErrorSchema).optional()
}).strict()

export const storageCategorySchema = z.object({
  kind: z.enum(['source', 'image', 'translation', 'other']),
  fileCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
}).strict()

export type StorageCategory = z.infer<typeof storageCategorySchema>

export const storageGrowthPointSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  totalBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
}).strict()

export const storageInfoSchema = z.object({
  rootPath: boundedPath,
  exists: z.boolean(),
  documentCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  fileCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  totalBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  categories: z.array(storageCategorySchema).min(4).max(5),
  growth: z.array(storageGrowthPointSchema).length(14)
}).strict()

export type StorageInfo = z.infer<typeof storageInfoSchema>

export const usageAnalyticsDaySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  documents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  pages: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  deepseekTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  codexTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  qwenTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
}).strict()

export type UsageAnalyticsDay = z.infer<typeof usageAnalyticsDaySchema>

export const usageAnalyticsSchema = z.object({
  days: z.array(usageAnalyticsDaySchema).min(1).max(366)
}).strict()

export type UsageAnalytics = z.infer<typeof usageAnalyticsSchema>
