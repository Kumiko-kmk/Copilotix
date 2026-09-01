import PQueue from 'p-queue'
import type { AppSettings, TranslationProviderId } from '@shared/types'
import type { CredentialVault } from '../credentialVault'
import {
  flattenSegments,
  parseTableTranslationResponse,
  TABLE_TRANSLATION_PROTOCOL,
  validateTableTranslationResponse,
  type TableTranslationRequest,
  type TableTranslationResponse
} from './tableTranslation'

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface TranslationProvider {
  readonly id: TranslationProviderId
  readonly model: string
  isAvailable(): Promise<boolean>
  translate(text: string): Promise<string>
  translateTable(request: TableTranslationRequest): Promise<TableTranslationResponse>
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

abstract class QueuedProvider implements TranslationProvider {
  abstract readonly id: TranslationProviderId
  abstract readonly model: string
  protected abstract readonly queue: PQueue
  abstract isAvailable(): Promise<boolean>
  protected abstract translateDirect(text: string): Promise<string>
  protected abstract translateTableDirect(request: TableTranslationRequest): Promise<TableTranslationResponse>

  translate(text: string): Promise<string> {
    return this.queue.add(() => this.translateDirect(text), { throwOnTimeout: true }) as Promise<string>
  }

  translateTable(request: TableTranslationRequest): Promise<TableTranslationResponse> {
    return this.queue.add(() => this.translateTableDirect(request), { throwOnTimeout: true }) as Promise<TableTranslationResponse>
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
    private readonly fetcher: Fetcher
  ) {
    super()
  }

  async isAvailable(): Promise<boolean> {
    return this.vault.has(this.credentialAccount)
  }

  protected async translateDirect(text: string): Promise<string> {
    const apiKey = await this.vault.get(this.credentialAccount)
    if (!apiKey) throw new Error(`${this.id} 尚未配置 API Key`)
    const response = await this.fetcher(`${this.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.1,
        messages: [
          {
            role: 'system',
            content:
              '你是严谨的学术翻译器。把用户提供的文本翻译为简体中文，不增删信息；保留人名、缩写、公式、代码和无法可靠翻译的术语。只输出译文。'
          },
          { role: 'user', content: text }
        ]
      }),
      signal: AbortSignal.timeout(90_000)
    })
    if (!response.ok) throw await toHttpError(response, `${this.id} 翻译失败`)
    const payload = (await response.json()) as any
    const translated = payload?.choices?.[0]?.message?.content
    if (typeof translated !== 'string' || !translated.trim()) throw new Error(`${this.id} 返回了空译文`)
    return translated.trim()
  }

  protected async translateTableDirect(request: TableTranslationRequest): Promise<TableTranslationResponse> {
    const apiKey = await this.vault.get(this.credentialAccount)
    if (!apiKey) throw new Error(`${this.id} 尚未配置 API Key`)
    const response = await this.fetcher(`${this.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.1,
        messages: [
          {
            role: 'system',
            content:
              '你是严谨的学术表格翻译器。翻译用户提供的完整表格 JSON 中所有 segment 的 text 为简体中文。必须保持 segment ID 完整、唯一，不得增删或修改表格结构、行列关系、HTML 属性和公式。只输出 JSON，格式为 {"protocol":"mineru-table-translation-v2","translations":[{"id":"segment-id","text":"译文"}]}。'
          },
          { role: 'user', content: JSON.stringify(request) }
        ]
      }),
      signal: AbortSignal.timeout(90_000)
    })
    if (!response.ok) throw await toHttpError(response, `${this.id} 表格翻译失败`)
    const payload = (await response.json()) as any
    const content = openAiContent(payload?.choices?.[0]?.message?.content)
    return parseTableTranslationResponse(content, request)
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

  protected async translateDirect(text: string): Promise<string> {
    return this.translateRemoteText(text)
  }

  protected async translateTableDirect(request: TableTranslationRequest): Promise<TableTranslationResponse> {
    const segments = flattenSegments(request)
    const translations: Array<{ id: string; text: string }> = []
    for (const segment of segments) {
      translations.push({ id: segment.id, text: await this.translateRemoteText(segment.text) })
    }
    return validateTableTranslationResponse({ protocol: TABLE_TRANSLATION_PROTOCOL, translations }, request)
  }

  private async translateRemoteText(text: string): Promise<string> {
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
      signal: AbortSignal.timeout(45_000)
    })
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) this.session = null
      throw await toHttpError(response, 'Bing 翻译接口暂不可用')
    }
    const payload = (await response.json()) as any
    const translated = payload?.[0]?.translations?.[0]?.text
    if (typeof translated !== 'string') throw new Error('Bing 返回了无法识别的结果')
    return translated
  }

  private async getSession(): Promise<NonNullable<BingProvider['session']>> {
    if (this.session && this.session.expiresAt > Date.now()) return this.session
    const response = await this.fetcher('https://www.bing.com/translator', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(30_000)
    })
    if (!response.ok) throw await toHttpError(response, '无法初始化 Bing 翻译会话')
    const html = await response.text()
    const ig = html.match(/IG:\"([^\"]+)\"/)?.[1] ?? html.match(/IG:"([^"]+)"/)?.[1]
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

  protected async translateDirect(text: string): Promise<string> {
    const translated = await this.translateRemoteTexts([text])
    return translated[0]!
  }

  protected async translateTableDirect(request: TableTranslationRequest): Promise<TableTranslationResponse> {
    const segments = flattenSegments(request)
    if (segments.length === 0) {
      return { protocol: TABLE_TRANSLATION_PROTOCOL, translations: [] }
    }
    const translated = await this.translateRemoteTexts(segments.map((segment) => segment.text))
    const translations = segments.map((segment, index) => ({ id: segment.id, text: translated[index]! }))
    return validateTableTranslationResponse({ protocol: TABLE_TRANSLATION_PROTOCOL, translations }, request)
  }

  private async translateRemoteTexts(texts: string[]): Promise<string[]> {
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
      signal: AbortSignal.timeout(45_000)
    })
    if (!response.ok) throw await toHttpError(response, 'TranSmart 翻译接口暂不可用')
    const payload = (await response.json()) as any
    const translated = payload?.auto_translation ?? payload?.target?.text_list
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
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const text = value
      .map((part) => (part && typeof part === 'object' && typeof (part as any).text === 'string' ? (part as any).text : ''))
      .join('')
    if (text) return text
  }
  throw new Error('OpenAI 兼容接口返回了无法识别的内容')
}

export function createTranslationProviders(
  settings: AppSettings,
  vault: CredentialVault,
  fetcher: Fetcher
): Map<TranslationProviderId, TranslationProvider> {
  return new Map<TranslationProviderId, TranslationProvider>([
    ['qwen', new OpenAiCompatibleProvider('qwen', settings.qwenModel, settings.qwenBaseUrl, 'qwen-api-key', vault, fetcher)],
    [
      'deepseek',
      new OpenAiCompatibleProvider(
        'deepseek',
        settings.deepseekModel,
        settings.deepseekBaseUrl,
        'deepseek-api-key',
        vault,
        fetcher
      )
    ],
    ['bing', new BingProvider(fetcher)],
    ['transmart', new TransmartProvider(fetcher)]
  ])
}

async function toHttpError(response: Response, prefix: string): Promise<TranslationHttpError> {
  const retryAfter = response.headers.get('retry-after')
  const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : undefined
  const body = await response.text()
  return new TranslationHttpError(
    `${prefix}（HTTP ${response.status}）${body ? `：${body.slice(0, 300)}` : ''}`,
    response.status,
    Number.isFinite(retryAfterMs) ? retryAfterMs : undefined
  )
}
