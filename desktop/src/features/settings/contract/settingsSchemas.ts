import { codexSettingsSchema, DEFAULT_CODEX_SETTINGS } from '@platform/codex/contract/codex'
import { paperChatProviderSchema, qwenChatModelSchema, deepseekChatModelSchema } from '@features/chat/contract/paperChatSchemas'
import { z } from 'zod'
import { boundedPath, hasControlCharacters, noNul } from '@platform/ipc/contract/validation'
import type { AppSettings, CredentialFieldError, CredentialMutation, CredentialName, CredentialStatus, CredentialStatuses, CredentialValidationResult, SettingsUpdate, SettingsSaveResult } from './settingsTypes'
import { translationProviderIdSchema } from '@features/translation/contract/translationSchemas'

/** IPC schemas for settings, credentials, storage and usage analytics. */

export const credentialNameSchema: z.ZodType<CredentialName> = z.enum(['parser', 'qwen', 'deepseek'])

export const credentialValueSchema = z.string()
  .trim()
  .min(1, '凭据不能为空')
  .max(16_384, '凭据过长')
  .refine(noNul, '凭据不能包含 NUL 字符')
  .refine((value) => !hasControlCharacters(value), '凭据不能包含控制字符')

export const credentialMutationSchema: z.ZodType<CredentialMutation> = z.union([
  z.object({ action: z.literal('set'), value: credentialValueSchema }).strict(),
  z.object({ action: z.literal('clear') }).strict()
])

export const credentialStatusesSchema: z.ZodType<CredentialStatuses> = z.object({
  parser: credentialStatusSchemaPlaceholder(),
  qwen: credentialStatusSchemaPlaceholder(),
  deepseek: credentialStatusSchemaPlaceholder()
}).strict()

export const translationProviderOrderSchema = z.array(translationProviderIdSchema).min(4).max(5).refine(
  (providers) => new Set(providers).size === providers.length && (providers.length === 5 || !providers.includes('codex')),
  '翻译模型顺序必须完整且不能重复'
)

export const enabledTranslationProvidersSchema = z.array(translationProviderIdSchema).min(1).max(5).refine(
  (providers) => new Set(providers).size === providers.length,
  '启用的翻译模型不能重复'
)

export function credentialStatusSchemaPlaceholder(): z.ZodType<CredentialStatus> {
  return z.object({
    state: z.enum(['missing', 'unknown', 'valid', 'invalid']),
    maskedValue: z.string().max(256).refine(noNul).optional(),
    errorCode: z.string().max(128).refine(noNul).optional(),
    message: z.string().max(1_024).refine(noNul).optional()
  }).strict()
}

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
  value: credentialValueSchema.optional()
}).strict()

export const appSettingsSchema: z.ZodType<AppSettings> = z.object({
  outputRoot: boundedPath,
  formulaEnabled: z.boolean(),
  tableEnabled: z.boolean(),
  translationProvider: translationProviderIdSchema,
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
  credentials: credentialStatusesSchema
}).strict().refine(
  (settings) => settings.translationProviderOrder.find((provider) => settings.enabledTranslationProviders.includes(provider)) === settings.translationProvider,
  '首选翻译模型必须是顺序中第一个已启用模型'
)

export const settingsUpdateSchema: z.ZodType<SettingsUpdate> = z.object({
  outputRoot: boundedPath,
  formulaEnabled: z.boolean(),
  tableEnabled: z.boolean(),
  translationProvider: translationProviderIdSchema,
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
  }).strict().optional()
}).strict().refine(
  (settings) => settings.translationProviderOrder.find((provider) => settings.enabledTranslationProviders.includes(provider)) === settings.translationProvider,
  '首选翻译模型必须是顺序中第一个已启用模型'
)

export const settingsSaveResultSchema: z.ZodType<SettingsSaveResult> = z.object({
  settings: appSettingsSchema,
  fieldErrors: z.object({
    parser: credentialFieldErrorSchema.optional(),
    qwen: credentialFieldErrorSchema.optional(),
    deepseek: credentialFieldErrorSchema.optional()
  }).strict()
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
