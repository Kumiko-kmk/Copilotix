import { z } from 'zod'

export const codexSettingsSchema = z.object({
  executable: z.string().max(32768).refine(value => ![...value].some(char => char.charCodeAt(0) < 32)).default(''),
  translationModel: z.string().max(128).default(''),
  chatModel: z.string().max(128).default(''),
  effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']).nullable().default(null)
}).strict()
export type CodexSettings = z.infer<typeof codexSettingsSchema>
export const DEFAULT_CODEX_SETTINGS: CodexSettings = { executable: '', translationModel: '', chatModel: '', effort: null }
export const codexModelSchema = z.object({
  id: z.string(), name: z.string(), image: z.boolean(), isDefault: z.boolean(),
  efforts: z.array(z.string()), defaultEffort: z.string()
}).strict()
export const codexStatusSchema = z.object({
  state: z.enum(['ready', 'missing', 'signed-out', 'unavailable']),
  executable: z.string(), version: z.string(), message: z.string(),
  models: z.array(codexModelSchema), verifiedModels: z.array(z.string())
}).strict()
export type CodexStatus = z.infer<typeof codexStatusSchema>
export const codexProbeSchema = z.object({ settings: codexSettingsSchema, testModel: z.string().max(128).optional() }).strict()
export interface CodexApi {
  inspect(request: z.infer<typeof codexProbeSchema>): Promise<CodexStatus>
  selectExecutable(): Promise<string | null>
}
