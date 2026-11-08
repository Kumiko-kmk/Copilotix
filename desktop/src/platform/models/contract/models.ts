import { z } from 'zod'

export const modelProviderSchema = z.enum(['qwen', 'deepseek', 'codex'])
export type ModelProvider = z.infer<typeof modelProviderSchema>
export type KeyProvider = Exclude<ModelProvider, 'codex'>
export const KEY_PROVIDERS = ['qwen', 'deepseek'] as const satisfies readonly KeyProvider[]
/** Each API-key provider holds at most this many keys; the settings page shows them without scrolling. */
export const MAX_KEYS_PER_PROVIDER = 5
export const MODEL_ENDPOINTS = { qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1', deepseek: 'https://api.deepseek.com', codex: 'stdio://codex' } as const

const CONNECTION_ID = /^(qwen|deepseek|codex):(default|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u
export const connectionIdSchema = z.string().regex(CONNECTION_ID)

/** The vault account is derived from the id, never chosen by the renderer. Default keys keep their 1.3.0 accounts. */
export function credentialRefFor(connectionId: string): string | null {
  const match = CONNECTION_ID.exec(connectionId)
  if (!match || match[1] === 'codex') return null
  return match[2] === 'default' ? `${match[1]}-api-key` : `api-key:${match[2]}`
}
export function connectionProvider(connectionId: string): ModelProvider | null {
  return (CONNECTION_ID.exec(connectionId)?.[1] as ModelProvider | undefined) ?? null
}
export function hasControlText(value: string): boolean {
  return [...value].some(character => { const code = character.codePointAt(0) ?? 0; return code <= 0x1f || (code >= 0x7f && code <= 0x9f) })
}

export const modelConnectionSchema = z.object({
  connectionId: connectionIdSchema, provider: modelProviderSchema,
  label: z.string().trim().max(24).refine(value => !hasControlText(value)).optional(),
  endpoint: z.string().min(1).max(2048), credentialRef: z.string().max(128).nullable(),
  enabled: z.boolean(), priority: z.number().int().nonnegative(),
  configVersion: z.string().max(128), quotaGroup: z.string().min(1).max(128)
}).strict()
  .refine(value => value.endpoint === MODEL_ENDPOINTS[value.provider], 'Unsupported model endpoint')
  .refine(value => connectionProvider(value.connectionId) === value.provider && value.credentialRef === credentialRefFor(value.connectionId), 'Connection identity mismatch')
  .refine(value => value.quotaGroup === value.provider, 'Connections share their provider budget')
export type ModelConnection = z.infer<typeof modelConnectionSchema>

export const modelConnectionsSchema = z.array(modelConnectionSchema).max(16).refine(
  connections => new Set(connections.map(value => value.connectionId)).size === connections.length,
  'Connection ids must be unique'
).refine(
  connections => KEY_PROVIDERS.every(provider => connections.filter(value => value.provider === provider).length <= MAX_KEYS_PER_PROVIDER),
  `Each provider holds at most ${MAX_KEYS_PER_PROVIDER} keys`
)

/** A stored key resolved for one request; the value never leaves the Main process. */
export interface ProviderKey { connection: ModelConnection; key: string }

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
export function createConnection(provider: ModelProvider, connectionId: string, priority: number, label?: string): ModelConnection {
  return {
    connectionId, provider, ...(label ? { label } : {}), endpoint: MODEL_ENDPOINTS[provider],
    credentialRef: credentialRefFor(connectionId), enabled: true, priority, configVersion: '1', quotaGroup: provider
  }
}
export function defaultConnections(): ModelConnection[] {
  return (['qwen', 'deepseek', 'codex'] as const).map((provider, priority) => createConnection(provider, `${provider}:default`, priority))
}
