import { z } from 'zod'

export const modelProviderSchema = z.enum(['qwen', 'deepseek', 'codex'])
export type ModelProvider = z.infer<typeof modelProviderSchema>
export const MODEL_ENDPOINTS = { qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1', deepseek: 'https://api.deepseek.com', codex: 'stdio://codex' } as const
export const modelConnectionSchema = z.object({
  connectionId: z.string().min(1).max(128), provider: modelProviderSchema,
  endpoint: z.string().min(1).max(2048), credentialRef: z.string().max(128).nullable(),
  enabled: z.boolean(), priority: z.number().int().nonnegative(),
  configVersion: z.string().max(128), quotaGroup: z.string().min(1).max(128)
}).strict().refine(value => value.endpoint === MODEL_ENDPOINTS[value.provider], 'Unsupported model endpoint')
export type ModelConnection = z.infer<typeof modelConnectionSchema>
export interface ModelRequest {
  purpose: 'translation' | 'chat' | 'brief' | 'figure'; model: string
  capabilities?: readonly ('text' | 'vision' | 'json')[]
  lane: 'interactive' | 'background'; candidates: readonly ModelConnection[]; signal: AbortSignal
}
export interface ModelUsage { promptTokens: number; completionTokens: number; totalTokens: number }
export interface ModelResult<T> {
  value: T; provider: ModelProvider; connectionId: string; model: string
  usage: ModelUsage | null; completion: 'completed' | 'partial'
}
export interface ConnectionHealth {
  status: 'unknown' | 'healthy' | 'cooldown' | 'probing' | 'invalid'
  reason?: string; nextAllowedAt: number; failures: number
}
export function defaultConnections(): ModelConnection[] {
  return (['qwen', 'deepseek', 'codex'] as const).map((provider, priority) => ({
    connectionId: `${provider}:default`, provider, endpoint: MODEL_ENDPOINTS[provider],
    credentialRef: provider === 'codex' ? null : `${provider}-api-key`, enabled: true,
    priority, configVersion: '1', quotaGroup: provider
  }))
}
