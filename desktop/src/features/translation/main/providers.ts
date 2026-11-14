import { postCompletion, completionUsage, CompletionHttpError as TranslationHttpError } from '@platform/models/main/completionTransport'
export { TranslationHttpError }
import { sharedModelRuntime } from '@platform/models/main/modelRuntime'
import type { ModelConnection, ModelUsage, ProviderKey } from '@platform/models/contract/models'
import type { AppSettings, CredentialName } from '@features/settings/contract/settingsTypes'
import type { HealthResult } from '@features/library/contract/documentTypes'
import type { TranslationProviderId } from '../contract/translationTypes'
import {
  flattenSegments,
  parseTableTranslationResponse,
  TABLE_TRANSLATION_PROTOCOL,
  validateTableTranslationResponse,
  type TableTranslationRequest,
  type TableTranslationResponse
} from '../contract/translationPlanProtocol'
import type { ProviderTokenUsage } from '@features/settings/main'

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
type UsageObserver = (provider: 'qwen' | 'deepseek', usage: ProviderTokenUsage) => void | Promise<void>
/** Verified, enabled keys of a provider in request order (SettingsService.providerKeys). */
export type ProviderKeySource = (provider: 'qwen' | 'deepseek') => Promise<readonly ProviderKey[]>


export interface TranslationProvider {
  readonly id: TranslationProviderId
  readonly model: string
  readonly credentialName?: CredentialName
  isAvailable(): Promise<boolean>
  translate(text: string, signal?: AbortSignal): Promise<string>
  translatePlain?(request: import('../contract/translationPlanProtocol').PlainTranslationRequest, signal: AbortSignal): Promise<import('../contract/translationPlanProtocol').PlainTranslationResponse>
  translateTable(request: TableTranslationRequest, signal?: AbortSignal): Promise<TableTranslationResponse>
}


export class TranslationCredentialError extends Error {
  constructor(
    message: string,
    readonly credentialName: CredentialName,
    readonly code = 'CREDENTIAL_REQUIRED'
  ) {
    super(message)
    this.name = 'TranslationCredentialError'
  }
}

abstract class QueuedProvider implements TranslationProvider {
  abstract readonly id: TranslationProviderId
  abstract readonly model: string
  abstract isAvailable(): Promise<boolean>
  protected abstract keys(): Promise<readonly ProviderKey[]>
  protected abstract translateDirect(text: string, key: string, signal?: AbortSignal): Promise<{ value: string; usage: ModelUsage | null }>
  protected abstract translateTableDirect(request: TableTranslationRequest, key: string, signal?: AbortSignal): Promise<{ value: TableTranslationResponse; usage: ModelUsage | null }>

  translate(text: string, signal?: AbortSignal): Promise<string> {
    return this.run(signal, key => this.translateDirect(text, key, signal))
  }

  translateTable(request: TableTranslationRequest, signal?: AbortSignal): Promise<TableTranslationResponse> {
    return this.run(signal, key => this.translateTableDirect(request, key, signal))
  }

  /** Each key is one candidate; the runtime moves to the next on cooldown or rejection and never retries the same key. */
  private async run<T>(signal: AbortSignal | undefined, operation: (key: string) => Promise<{ value: T; usage: ModelUsage | null }>): Promise<T> {
    const keys = await this.keys()
    if (!keys.length) throw new TranslationCredentialError(`${this.id} 尚未配置可用的 API Key`, this.id as CredentialName)
    const byConnection = new Map(keys.map(entry => [entry.connection.connectionId, entry.key]))
    const result = await sharedModelRuntime.execute(
      { purpose: 'translation', model: this.model, lane: 'background', candidates: keys.map(entry => entry.connection), signal: signal ?? new AbortController().signal },
      (connection: ModelConnection) => operation(byConnection.get(connection.connectionId)!)
    )
    return result.value
  }
}

class OpenAiCompatibleProvider extends QueuedProvider {
  constructor(
    readonly id: 'qwen' | 'deepseek',
    readonly model: string,
    private readonly baseUrl: string,
    private readonly source: ProviderKeySource,
    private readonly fetcher: Fetcher,
    private readonly onUsage?: UsageObserver
  ) {
    super()
  }

  protected keys(): Promise<readonly ProviderKey[]> {
    return this.source(this.id)
  }

  get credentialName(): 'qwen' | 'deepseek' {
    return this.id
  }

  async isAvailable(): Promise<boolean> {
    return (await this.keys()).length > 0
  }

  override async translateTable(request: TableTranslationRequest, signal?: AbortSignal): Promise<TableTranslationResponse> {
    if (!isQwenMtModel(this.id, this.model)) return super.translateTable(request, signal)
    const segments = flattenSegments(request)
    const translations = new Array<{ id: string; text: string }>(segments.length)
    let cursor = 0
    let failure: { error: unknown } | undefined
    // Each cell enters the same provider-wide HTTP budget as normal text;
    // never hold an outer table slot while waiting for these inner requests.
    await Promise.all(Array.from({ length: Math.min(4, segments.length) }, async () => {
      try {
      for (;;) {
        if (failure) return
        signal?.throwIfAborted()
        const index = cursor++
        const segment = segments[index]
        if (!segment) return
        translations[index] = { id: segment.id, text: await this.translate(segment.text, signal) }
      }
      } catch (error) { failure ??= { error } }
    }))
    if (failure) throw failure.error
    return validateTableTranslationResponse({ protocol: TABLE_TRANSLATION_PROTOCOL, translations }, request)
  }

  protected translateDirect(text: string, key: string, signal?: AbortSignal): Promise<{ value: string; usage: ModelUsage | null }> {
    return this.translateText(key, text, signal)
  }

  private async translateText(apiKey: string, text: string, signal?: AbortSignal): Promise<{ value: string; usage: ModelUsage | null }> {
    const payload = await postCompletion(this.fetcher, this.id, this.baseUrl, apiKey, translationRequestBody(this.id, this.model, text), signal)
    await this.reportUsage(payload)
    return { value: openAiResponseContent(payload, this.id), usage: completionUsage(payload) }
  }

  protected async translateTableDirect(request: TableTranslationRequest, apiKey: string, signal?: AbortSignal): Promise<{ value: TableTranslationResponse; usage: ModelUsage | null }> {
    const payload = await postCompletion(this.fetcher, this.id, this.baseUrl, apiKey, {
        model: this.model,
        ...(this.id === 'deepseek' ? { thinking: { type: 'disabled' } } : {}),
        temperature: 0.1,
        messages: [
          {
            role: 'system',
            content:
              '你是嚴謹的學術表格翻譯器。翻譯使用者提供的完整表格 JSON 中所有 segment 的 text 為臺灣正體中文。必須保持 segment ID 完整、唯一，不得增刪或修改表格結構、行列關係、HTML 屬性和公式。只輸出 JSON，格式為 {"protocol":"copilotix-table-translation-v2","translations":[{"id":"segment-id","text":"譯文"}]}。'
          },
          { role: 'user', content: JSON.stringify(request) }
        ]
      }, signal)
    await this.reportUsage(payload)
    const content = openAiResponseContent(payload, this.id)
    return { value: parseTableTranslationResponse(content, request), usage: completionUsage(payload) }
  }

  private async reportUsage(payload: unknown): Promise<void> {
    const usage = completionUsage(payload)
    if (usage && this.onUsage) await this.onUsage(this.id, usage)
  }
}

function openAiContent(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (Array.isArray(value)) {
    const parts = value.map((part) => {
      const record = asRecord(part)
      return typeof record?.text === 'string' ? record.text : null
    })
    if (parts.every((part): part is string => part !== null)) {
      const text = parts.join('').trim()
      if (text) return text
    }
  }
  throw new Error('OpenAI 相容介面返回了無法識別的內容')
}

function openAiResponseContent(payload: unknown, providerId: string): string {
  const root = asRecord(payload)
  const choices = root?.choices
  const firstChoice = Array.isArray(choices) ? asRecord(choices[0]) : null
  const message = asRecord(firstChoice?.message)
  try {
    return openAiContent(message?.content)
  } catch {
    throw new Error(`${providerId} 返回了無法識別的譯文`)
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function createTranslationProviders(
  settings: AppSettings,
  keys: ProviderKeySource,
  fetcher: Fetcher,
  onUsage?: UsageObserver
): Map<TranslationProviderId, TranslationProvider> {
  return new Map<TranslationProviderId, TranslationProvider>([
    ['qwen', new OpenAiCompatibleProvider('qwen', settings.qwenModel, settings.qwenBaseUrl, keys, fetcher, onUsage)],
    ['deepseek', new OpenAiCompatibleProvider('deepseek', settings.deepseekModel, settings.deepseekBaseUrl, keys, fetcher, onUsage)]
  ])
}

/** Validate a candidate OpenAI-compatible credential without touching the vault. */
export async function probeOpenAiCompatibleCredential(
  providerId: 'qwen' | 'deepseek',
  settings: AppSettings,
  apiKey: string,
  fetcher: Fetcher
): Promise<HealthResult> {
  const baseUrl = providerId === 'qwen' ? settings.qwenBaseUrl : settings.deepseekBaseUrl
  const model = providerId === 'qwen' ? settings.qwenModel : settings.deepseekModel
  const response = providerId === 'deepseek'
    ? await fetcher(`${baseUrl.replace(/\/+$/, '')}/models`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey.trim()}`,
          Accept: 'application/json'
        },
        signal: AbortSignal.timeout(15_000)
      })
    : await fetcher(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey.trim()}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(credentialProbeBody(providerId, model)),
        signal: AbortSignal.timeout(15_000)
      })
  if (!response.ok) {
    const code = response.status === 401 || response.status === 403
      ? 'AUTH_INVALID'
      : response.status === 407
        ? 'PROXY_AUTH_REQUIRED'
        : response.status === 400 || response.status === 404
          ? 'PROVIDER_CONFIGURATION_INVALID'
      : `HTTP_${response.status}`
    const message = code === 'AUTH_INVALID'
      ? `${providerId} API Key 驗證失敗（HTTP ${response.status}）`
      : code === 'PROXY_AUTH_REQUIRED'
        ? '網路代理要求身份驗證，請檢查或關閉代理後重試'
        : code === 'PROVIDER_CONFIGURATION_INVALID'
          ? `${providerId} 服務地址或模型配置不可用（HTTP ${response.status}）`
          : `${providerId} 服務暫時不可用（HTTP ${response.status}）`
    return { ok: false, code, message }
  }
  if (providerId === 'deepseek') return { ok: true, message: 'deepseek API Key 驗證成功' }
  try {
    const payload: unknown = await response.json()
    openAiResponseContent(payload, providerId)
    return { ok: true, message: `${providerId} API Key 驗證成功` }
  } catch {
    return { ok: false, code: 'INVALID_RESPONSE', message: `${providerId} 介面返回了無法識別的響應` }
  }
}

function credentialProbeBody(providerId: 'qwen' | 'deepseek', model: string): Record<string, unknown> {
  if (isQwenMtModel(providerId, model)) {
    return {
      model,
      messages: [{ role: 'user', content: 'Hello' }],
      translation_options: { source_lang: 'English', target_lang: 'Traditional Chinese' }
    }
  }
  return {
    model,
    ...(providerId === 'deepseek' ? { thinking: { type: 'disabled' } } : {}),
    temperature: 0,
    max_tokens: 16,
    messages: [
      { role: 'system', content: '只輸出 OK。' },
      { role: 'user', content: 'OK' }
    ]
  }
}

function translationRequestBody(providerId: 'qwen' | 'deepseek', model: string, text: string): Record<string, unknown> {
  if (isQwenMtModel(providerId, model)) {
    return {
      model,
      messages: [{ role: 'user', content: text }],
      translation_options: { source_lang: 'auto', target_lang: 'Traditional Chinese' }
    }
  }
  return {
    model,
    ...(providerId === 'deepseek' ? { thinking: { type: 'disabled' } } : {}),
    temperature: 0.1,
    messages: [
      {
        role: 'system',
        content:
          '你是嚴謹的學術翻譯器。把使用者提供的文字翻譯為臺灣正體中文，不增刪資訊；保留人名、縮寫、公式、程式碼和無法可靠翻譯的術語。只輸出譯文。'
      },
      { role: 'user', content: text }
    ]
  }
}

function isQwenMtModel(providerId: 'qwen' | 'deepseek', model: string): boolean {
  return providerId === 'qwen' && /^qwen-mt(?:-|$)/iu.test(model.trim())
}
