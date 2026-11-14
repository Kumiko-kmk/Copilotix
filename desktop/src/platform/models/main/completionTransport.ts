import { MODEL_ENDPOINTS, type ModelProvider, type ModelUsage } from '../contract/models'
export class CompletionHttpError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterMs?: number) { super(message) }
}
export async function postCompletion(fetcher: (input: string, init?: RequestInit) => Promise<Response>, provider: Exclude<ModelProvider, 'codex'>, endpoint: string, key: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  if (endpoint !== MODEL_ENDPOINTS[provider]) throw new CompletionHttpError('模型服务地址不受支持', 400)
  const timeout = AbortSignal.timeout(90_000)
  const response = await fetcher(endpoint + '/chat/completions', { method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
  if (!response.ok) {
    const header = response.headers.get('retry-after')
    const seconds = header && /^\d+(?:\.\d+)?$/u.test(header) ? Number(header) * 1000 : header ? Date.parse(header) - Date.now() : undefined
    await response.body?.cancel().catch(() => undefined)
    throw new CompletionHttpError(provider + ' 请求失败（HTTP ' + response.status + '）', response.status, seconds !== undefined && Number.isFinite(seconds) ? Math.max(0, seconds) : undefined)
  }
  return response.json()
}
export function completionUsage(payload: unknown): ModelUsage | null {
  const usage = payload && typeof payload === 'object' && 'usage' in payload ? payload.usage : null
  if (!usage || typeof usage !== 'object') return null
  const record = usage as Record<string, unknown>
  const integer = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
  const prompt = integer(record.prompt_tokens), completion = integer(record.completion_tokens), total = integer(record.total_tokens)
  return prompt === null && completion === null && total === null ? null : { promptTokens: prompt ?? 0, completionTokens: completion ?? 0, totalTokens: total ?? (prompt ?? 0) + (completion ?? 0) }
}
