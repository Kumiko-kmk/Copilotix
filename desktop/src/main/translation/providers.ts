import PQueue from 'p-queue'
import type { AppSettings, CredentialName, HealthResult, TranslationProviderId } from '@shared/types'
import type { CredentialVault } from '../credentialVault'
import {
  flattenSegments,
  parseTableTranslationResponse,
  TABLE_TRANSLATION_PROTOCOL,
  validateTableTranslationResponse,
  type TableTranslationRequest,
  type TableTranslationResponse
} from '@shared/translationPlanProtocol'
import type { ProviderTokenUsage } from '../usageAnalyticsService'

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
type UsageObserver = (provider: 'qwen' | 'deepseek', usage: ProviderTokenUsage) => void | Promise<void>

export interface TranslationProvider {
  readonly id: TranslationProviderId
  readonly model: string
  readonly credentialName?: CredentialName
  isAvailable(): Promise<boolean>
  translate(text: string, signal?: AbortSignal): Promise<string>
  translateTable(request: TableTranslationRequest, signal?: AbortSignal): Promise<TableTranslationResponse>
}

export class TranslationHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number
  ) {
    super(message)
  }
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
  protected abstract readonly queue: PQueue
  abstract isAvailable(): Promise<boolean>
  protected abstract translateDirect(text: string, signal?: AbortSignal): Promise<string>
  protected abstract translateTableDirect(request: TableTranslationRequest, signal?: AbortSignal): Promise<TableTranslationResponse>

  translate(text: string, signal?: AbortSignal): Promise<string> {
    return this.queue.add(() => this.translateDirect(text, signal), { throwOnTimeout: true }) as Promise<string>
  }

  translateTable(request: TableTranslationRequest, signal?: AbortSignal): Promise<TableTranslationResponse> {
    return this.queue.add(() => this.translateTableDirect(request, signal), { throwOnTimeout: true }) as Promise<TableTranslationResponse>
  }
}

class OpenAiCompatibleProvider extends QueuedProvider {
  protected readonly queue = new PQueue({ concurrency: 3 })

  constructor(
    readonly id: 'qwen' | 'deepseek',
    readonly model: string,
    private readonly baseUrl: string,
    private readonly credentialAccount: 'qwen-api-key' | 'deepseek-api-key',
    private readonly vault: CredentialVault,
    private readonly fetcher: Fetcher,
    private readonly credentialState: AppSettings['credentials']['qwen']['state'],
    private readonly onUsage?: UsageObserver
  ) {
    super()
  }

  get credentialName(): 'qwen' | 'deepseek' {
    return this.id
  }

  async isAvailable(): Promise<boolean> {
    return this.credentialState === 'valid' && Boolean(await this.vault.get(this.credentialAccount))
  }

  protected async translateDirect(text: string, signal?: AbortSignal): Promise<string> {
    const apiKey = await this.vault.get(this.credentialAccount)
    if (!apiKey) throw new TranslationCredentialError(`${this.id} 尚未配置 API Key`, this.id)
    return this.translateText(apiKey, text, signal)
  }

  private async translateText(apiKey: string, text: string, signal?: AbortSignal): Promise<string> {
    const response = await this.fetcher(`${this.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(translationRequestBody(this.id, this.model, text)),
      signal: requestSignal(signal, 90_000)
    })
    if (!response.ok) throw await toHttpError(response, `${this.id} 翻译失败`)
    const payload: unknown = await response.json()
    await this.reportUsage(payload)
    return openAiResponseContent(payload, this.id)
  }

  protected async translateTableDirect(request: TableTranslationRequest, signal?: AbortSignal): Promise<TableTranslationResponse> {
    const apiKey = await this.vault.get(this.credentialAccount)
    if (!apiKey) throw new TranslationCredentialError(`${this.id} 尚未配置 API Key`, this.id)
    if (isQwenMtModel(this.id, this.model)) {
      const translations: Array<{ id: string; text: string }> = []
      for (const segment of flattenSegments(request)) {
        translations.push({ id: segment.id, text: await this.translateText(apiKey, segment.text, signal) })
      }
      return validateTableTranslationResponse({ protocol: TABLE_TRANSLATION_PROTOCOL, translations }, request)
    }
    const response = await this.fetcher(`${this.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: this.model,
        ...(this.id === 'deepseek' ? { thinking: { type: 'disabled' } } : {}),
        temperature: 0.1,
        messages: [
          {
            role: 'system',
            content:
              '你是严谨的学术表格翻译器。翻译用户提供的完整表格 JSON 中所有 segment 的 text 为简体中文。必须保持 segment ID 完整、唯一，不得增删或修改表格结构、行列关系、HTML 属性和公式。只输出 JSON，格式为 {"protocol":"copilotix-table-translation-v2","translations":[{"id":"segment-id","text":"译文"}]}。'
          },
          { role: 'user', content: JSON.stringify(request) }
        ]
      }),
      signal: requestSignal(signal, 90_000)
    })
    if (!response.ok) throw await toHttpError(response, `${this.id} 表格翻译失败`)
    const payload: unknown = await response.json()
    await this.reportUsage(payload)
    const content = openAiResponseContent(payload, this.id)
    return parseTableTranslationResponse(content, request)
  }

  private async reportUsage(payload: unknown): Promise<void> {
    const usage = openAiTokenUsage(payload)
    if (usage && this.onUsage) await this.onUsage(this.id, usage)
  }
}

class BingProvider extends QueuedProvider {
  readonly id = 'bing' as const
  readonly model = 'bing-translator-web'
  protected readonly queue = new PQueue({ concurrency: 1 })
  private session: { ig: string; iid: string; key: string; token: string; expiresAt: number } | null = null

  constructor(private readonly fetcher: Fetcher) {
    super()
  }

  async isAvailable(): Promise<boolean> {
    return true
  }

  protected async translateDirect(text: string, signal?: AbortSignal): Promise<string> {
    return this.translateRemoteText(text, signal)
  }

  protected async translateTableDirect(request: TableTranslationRequest, signal?: AbortSignal): Promise<TableTranslationResponse> {
    const segments = flattenSegments(request)
    const translations: Array<{ id: string; text: string }> = []
    for (const segment of segments) {
      translations.push({ id: segment.id, text: await this.translateRemoteText(segment.text, signal) })
    }
    return validateTableTranslationResponse({ protocol: TABLE_TRANSLATION_PROTOCOL, translations }, request)
  }

  private async translateRemoteText(text: string, signal?: AbortSignal): Promise<string> {
    const session = await this.getSession()
    const body = new URLSearchParams({
      fromLang: 'auto-detect',
      text,
      to: 'zh-Hans',
      token: session.token,
      key: session.key
    })
    const url = `https://www.bing.com/ttranslatev3?isVertical=1&IG=${encodeURIComponent(session.ig)}&IID=${encodeURIComponent(session.iid)}`
    const response = await this.fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body,
      signal: requestSignal(signal, 45_000)
    })
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) this.session = null
      throw await toHttpError(response, 'Bing 翻译接口暂不可用')
    }
    const payload: unknown = await response.json()
    return bingResponseText(payload)
  }

  private async getSession(): Promise<NonNullable<BingProvider['session']>> {
    if (this.session && this.session.expiresAt > Date.now()) return this.session
    const response = await this.fetcher('https://www.bing.com/translator', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(30_000)
    })
    if (!response.ok) throw await toHttpError(response, '无法初始化 Bing 翻译会话')
    const html = await response.text()
    const ig = html.match(/IG:"([^"]+)"/)?.[1]
    const helper = html.match(/params_AbusePreventionHelper\s*=\s*\[(\d+),\s*"([^"]+)"/)
    if (!ig || !helper?.[1] || !helper[2]) throw new Error('Bing 页面格式已变化，请改用其他翻译源')
    this.session = {
      ig,
      iid: 'translator.5028.1',
      key: helper[1],
      token: helper[2],
      expiresAt: Date.now() + 20 * 60 * 1000
    }
    return this.session
  }
}

class TransmartProvider extends QueuedProvider {
  readonly id = 'transmart' as const
  readonly model = 'transmart-web'
  protected readonly queue = new PQueue({ concurrency: 1 })

  constructor(private readonly fetcher: Fetcher) {
    super()
  }

  async isAvailable(): Promise<boolean> {
    return true
  }

  protected async translateDirect(text: string, signal?: AbortSignal): Promise<string> {
    const translated = await this.translateRemoteTexts([text], signal)
    return translated[0]!
  }

  protected async translateTableDirect(request: TableTranslationRequest, signal?: AbortSignal): Promise<TableTranslationResponse> {
    const segments = flattenSegments(request)
    if (segments.length === 0) {
      return { protocol: TABLE_TRANSLATION_PROTOCOL, translations: [] }
    }
    const translated = await this.translateRemoteTexts(segments.map((segment) => segment.text), signal)
    const translations = segments.map((segment, index) => ({ id: segment.id, text: translated[index]! }))
    return validateTableTranslationResponse({ protocol: TABLE_TRANSLATION_PROTOCOL, translations }, request)
  }

  private async translateRemoteTexts(texts: string[], signal?: AbortSignal): Promise<string[]> {
    const response = await this.fetcher('https://transmart.qq.com/api/imt', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://transmart.qq.com',
        Referer: 'https://transmart.qq.com/zh-CN/index'
      },
      body: JSON.stringify({
        header: { fn: 'auto_translation', client_key: 'browser-chrome-1.0.0' },
        type: 'plain',
        model_category: 'normal',
        source: { lang: 'auto', text_list: texts },
        target: { lang: 'zh' }
      }),
      signal: requestSignal(signal, 45_000)
    })
    if (!response.ok) throw await toHttpError(response, 'TranSmart 翻译接口暂不可用')
    const payload: unknown = await response.json()
    const root = asRecord(payload)
    const translated = root?.auto_translation ?? asRecord(root?.target)?.text_list
    if (!Array.isArray(translated)) throw new Error('TranSmart 返回了无法识别的结果')
    if (translated.length !== texts.length) {
      throw new Error(`TranSmart 批量响应数量不匹配：预期 ${texts.length}，实际 ${translated.length}`)
    }
    return translated.map((value: unknown, index: number) => {
      if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`TranSmart 批量响应第 ${index + 1} 项为空或无效`)
      }
      return value
    })
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
  throw new Error('OpenAI 兼容接口返回了无法识别的内容')
}

function openAiResponseContent(payload: unknown, providerId: string): string {
  const root = asRecord(payload)
  const choices = root?.choices
  const firstChoice = Array.isArray(choices) ? asRecord(choices[0]) : null
  const message = asRecord(firstChoice?.message)
  try {
    return openAiContent(message?.content)
  } catch {
    throw new Error(`${providerId} 返回了无法识别的译文`)
  }
}

function bingResponseText(payload: unknown): string {
  const first = Array.isArray(payload) ? asRecord(payload[0]) : null
  const translations = first?.translations
  const firstTranslation = Array.isArray(translations) ? asRecord(translations[0]) : null
  const text = firstTranslation?.text
  if (typeof text !== 'string' || !text.trim()) throw new Error('Bing 返回了无法识别的结果')
  return text.trim()
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function createTranslationProviders(
  settings: AppSettings,
  vault: CredentialVault,
  fetcher: Fetcher,
  onUsage?: UsageObserver
): Map<TranslationProviderId, TranslationProvider> {
  return new Map<TranslationProviderId, TranslationProvider>([
    ['qwen', new OpenAiCompatibleProvider('qwen', settings.qwenModel, settings.qwenBaseUrl, 'qwen-api-key', vault, fetcher, settings.credentials.qwen.state, onUsage)],
    [
      'deepseek',
      new OpenAiCompatibleProvider(
        'deepseek',
        settings.deepseekModel,
        settings.deepseekBaseUrl,
        'deepseek-api-key',
        vault,
        fetcher,
        settings.credentials.deepseek.state,
        onUsage
      )
    ],
    ['bing', new BingProvider(fetcher)],
    ['transmart', new TransmartProvider(fetcher)]
  ])
}

function openAiTokenUsage(payload: unknown): ProviderTokenUsage | null {
  const usage = asRecord(asRecord(payload)?.usage)
  const promptTokens = nonNegativeUsageInteger(usage?.prompt_tokens)
  const completionTokens = nonNegativeUsageInteger(usage?.completion_tokens)
  const totalTokens = nonNegativeUsageInteger(usage?.total_tokens)
  if (totalTokens === null && promptTokens === null && completionTokens === null) return null
  return {
    promptTokens: promptTokens ?? 0,
    completionTokens: completionTokens ?? 0,
    totalTokens: totalTokens ?? (promptTokens ?? 0) + (completionTokens ?? 0)
  }
}

function nonNegativeUsageInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
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
      ? `${providerId} API Key 验证失败（HTTP ${response.status}）`
      : code === 'PROXY_AUTH_REQUIRED'
        ? '网络代理要求身份验证，请检查或关闭代理后重试'
        : code === 'PROVIDER_CONFIGURATION_INVALID'
          ? `${providerId} 服务地址或模型配置不可用（HTTP ${response.status}）`
          : `${providerId} 服务暂时不可用（HTTP ${response.status}）`
    return { ok: false, code, message }
  }
  if (providerId === 'deepseek') return { ok: true, message: 'deepseek API Key 验证成功' }
  try {
    const payload: unknown = await response.json()
    openAiResponseContent(payload, providerId)
    return { ok: true, message: `${providerId} API Key 验证成功` }
  } catch {
    return { ok: false, code: 'INVALID_RESPONSE', message: `${providerId} 接口返回了无法识别的响应` }
  }
}

function credentialProbeBody(providerId: 'qwen' | 'deepseek', model: string): Record<string, unknown> {
  if (isQwenMtModel(providerId, model)) {
    return {
      model,
      messages: [{ role: 'user', content: 'Hello' }],
      translation_options: { source_lang: 'English', target_lang: 'Chinese' }
    }
  }
  return {
    model,
    ...(providerId === 'deepseek' ? { thinking: { type: 'disabled' } } : {}),
    temperature: 0,
    max_tokens: 16,
    messages: [
      { role: 'system', content: '只输出 OK。' },
      { role: 'user', content: 'OK' }
    ]
  }
}

function translationRequestBody(providerId: 'qwen' | 'deepseek', model: string, text: string): Record<string, unknown> {
  if (isQwenMtModel(providerId, model)) {
    return {
      model,
      messages: [{ role: 'user', content: text }],
      translation_options: { source_lang: 'auto', target_lang: 'Chinese' }
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
          '你是严谨的学术翻译器。把用户提供的文本翻译为简体中文，不增删信息；保留人名、缩写、公式、代码和无法可靠翻译的术语。只输出译文。'
      },
      { role: 'user', content: text }
    ]
  }
}

function isQwenMtModel(providerId: 'qwen' | 'deepseek', model: string): boolean {
  return providerId === 'qwen' && /^qwen-mt(?:-|$)/iu.test(model.trim())
}

async function toHttpError(response: Response, prefix: string): Promise<TranslationHttpError> {
  const retryAfter = response.headers.get('retry-after')
  const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : undefined
  // Do not copy a provider response body into an Error.  Some gateways echo
  // request data (including an API key) in error payloads; keeping the body out
  // of the error prevents it from reaching task state or logs.
  return new TranslationHttpError(
    `${prefix}（HTTP ${response.status}）`,
    response.status,
    Number.isFinite(retryAfterMs) ? retryAfterMs : undefined
  )
}

function requestSignal(jobSignal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  return jobSignal ? AbortSignal.any([jobSignal, timeoutSignal]) : timeoutSignal
}
