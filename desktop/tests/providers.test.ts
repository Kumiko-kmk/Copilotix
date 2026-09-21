import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/constants'
import { createTranslationProviders, probeOpenAiCompatibleCredential } from '@main/translation/providers'
import { buildTableTranslationPlan } from '../src/utility/core/compute/tableTranslation'
import {
  flattenSegments,
  type TableTranslationRequest
} from '@shared/translationPlanProtocol'
import type { CredentialVault } from '@main/credentialVault'

const vault: CredentialVault = {
  get: async () => null,
  set: async () => undefined,
  delete: async () => undefined,
  has: async () => false
}

interface OpenAiRequestBody {
  model?: string
  max_tokens?: number
  thinking?: { type: string }
  messages: Array<{ role: string; content: string }>
  translation_options?: { source_lang?: string; target_lang?: string }
}

function tableRequest(): TableTranslationRequest {
  return buildTableTranslationPlan([
    { sourceIndex: 0, markdown: 'Table 1. Results', mappingIds: [] },
    { sourceIndex: 1, markdown: '<table><tr><td>Accuracy</td><td>Recall</td></tr></table>', mappingIds: [] }
  ])!.request
}

describe('table provider transports', () => {
  it('validates a candidate key without writing it to the vault', async () => {
    const calls: Array<{ url: string; headers?: HeadersInit; body?: string }> = []
    const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(input), headers: init?.headers, body: String(init?.body) })
      return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { status: 200 })
    }
    const settings = {
      ...DEFAULT_SETTINGS,
      credentials: {
        parser: { state: 'missing' as const },
        qwen: { state: 'missing' as const },
        deepseek: { state: 'missing' as const }
      }
    }
    const result = await probeOpenAiCompatibleCredential('qwen', settings, 'candidate-key', fetcher)

    expect(result).toMatchObject({ ok: true })
    expect(calls[0]?.url).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions')
    expect(calls[0]?.headers).toMatchObject({ Authorization: 'Bearer candidate-key' })
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      model: 'qwen-mt-plus',
      messages: [{ role: 'user', content: 'Hello' }],
      translation_options: { source_lang: 'English', target_lang: 'Chinese' }
    })
  })

  it('validates DeepSeek credentials through the models endpoint without spending generation tokens', async () => {
    let request: { url: string; init?: RequestInit } | undefined
    const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      request = { url: String(input), init }
      return new Response(JSON.stringify({ data: [{ id: 'deepseek-flash' }] }), { status: 200 })
    }

    await expect(probeOpenAiCompatibleCredential('deepseek', DEFAULT_SETTINGS, 'candidate-key', fetcher))
      .resolves.toMatchObject({ ok: true })
    expect(request?.url).toBe('https://api.deepseek.com/models')
    expect(request?.init?.method).toBe('GET')
    expect(request?.init?.body).toBeUndefined()
    expect(request?.init?.headers).toMatchObject({ Authorization: 'Bearer candidate-key', Accept: 'application/json' })
  })

  it('maps Qwen/DeepSeek authentication responses to a non-retryable validation error', async () => {
    const fetcher = async (): Promise<Response> => new Response('', { status: 401 })
    const result = await probeOpenAiCompatibleCredential('deepseek', DEFAULT_SETTINGS, 'wrong-key', fetcher)
    expect(result).toEqual({ ok: false, code: 'AUTH_INVALID', message: 'deepseek API Key 验证失败（HTTP 401）' })
  })

  it('sends the complete v2 JSON request to OpenAI-compatible providers', async () => {
    const requestBodies: OpenAiRequestBody[] = []
    const keyVault: CredentialVault = {
      ...vault,
      get: async (account) => account === 'qwen-api-key' ? 'fixture-key' : null,
      has: async (account) => account === 'qwen-api-key'
    }
    const fetcher = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as OpenAiRequestBody
      requestBodies.push(body)
      const request = JSON.parse(body.messages[1]!.content) as TableTranslationRequest
      const content = JSON.stringify({
        protocol: request.protocol,
        translations: flattenSegments(request).map((segment) => ({ id: segment.id, text: `译:${segment.text}` }))
      })
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }
    const request = tableRequest()
    const provider = createTranslationProviders({ ...DEFAULT_SETTINGS, qwenModel: 'qwen-plus' }, keyVault, fetcher).get('qwen')!
    const response = await provider.translateTable(request)

    expect(requestBodies).toHaveLength(1)
    expect(requestBodies[0]!.messages[1]!.content).toContain('copilotix-table-translation-v2')
    expect(requestBodies[0]!.messages[1]!.content).toContain('Table 1. Results')
    expect(response.translations).toHaveLength(flattenSegments(request).length)
  })

  it('disables DeepSeek thinking mode so translated content is returned directly', async () => {
    let body: OpenAiRequestBody | undefined
    const usage = vi.fn()
    const keyVault: CredentialVault = {
      ...vault,
      get: async (account) => account === 'deepseek-api-key' ? 'fixture-key' : null,
      has: async (account) => account === 'deepseek-api-key'
    }
    const fetcher = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      body = JSON.parse(String(init?.body)) as OpenAiRequestBody
      return new Response(JSON.stringify({
        choices: [{ message: { content: '译文' } }],
        usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 }
      }), { status: 200 })
    }
    const provider = createTranslationProviders(DEFAULT_SETTINGS, keyVault, fetcher, usage).get('deepseek')!

    await expect(provider.translate('source')).resolves.toBe('译文')
    expect(body?.model).toBe('deepseek-flash')
    expect(body?.thinking).toEqual({ type: 'disabled' })
    expect(usage).toHaveBeenCalledWith('deepseek', { promptTokens: 12, completionTokens: 5, totalTokens: 17 })
  })

  it('uses the Qwen-MT transport for text and translates table segments independently', async () => {
    const requestBodies: OpenAiRequestBody[] = []
    const keyVault: CredentialVault = {
      ...vault,
      get: async (account) => account === 'qwen-api-key' ? 'fixture-key' : null,
      has: async (account) => account === 'qwen-api-key'
    }
    const fetcher = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as OpenAiRequestBody
      requestBodies.push(body)
      return new Response(JSON.stringify({ choices: [{ message: { content: `译:${body.messages[0]!.content}` } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }
    const provider = createTranslationProviders(DEFAULT_SETTINGS, keyVault, fetcher).get('qwen')!

    await expect(provider.translate('hello')).resolves.toBe('译:hello')
    const request = tableRequest()
    const response = await provider.translateTable(request)

    expect(requestBodies.every((body) => body.messages.length === 1)).toBe(true)
    expect(requestBodies.every((body) => body.translation_options?.target_lang === 'Chinese')).toBe(true)
    expect(requestBodies).toHaveLength(1 + flattenSegments(request).length)
    expect(response.translations).toEqual(flattenSegments(request).map((segment) => ({
      id: segment.id,
      text: `译:${segment.text}`
    })))
  })

  it('uses one native TranSmart text_list request and maps its ordered array response', async () => {
    const bodies: any[] = []
    const fetcher = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body))
      bodies.push(body)
      return new Response(JSON.stringify({
        header: { ret_code: 'succ' },
        auto_translation: body.source.text_list.map((text: string) => `译:${text}`)
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    const request = tableRequest()
    const provider = createTranslationProviders(DEFAULT_SETTINGS, vault, fetcher).get('transmart')!
    const response = await provider.translateTable(request)

    expect(bodies).toHaveLength(1)
    expect(bodies[0].source.text_list).toEqual(flattenSegments(request).map((segment) => segment.text))
    expect(response.translations).toEqual(flattenSegments(request).map((segment) => ({
      id: segment.id,
      text: `译:${segment.text}`
    })))
  })

  it('rejects a TranSmart batch response with a different count', async () => {
    const fetcher = async (): Promise<Response> => new Response(JSON.stringify({
      header: { ret_code: 'succ' },
      auto_translation: ['只有一项']
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    const provider = createTranslationProviders(DEFAULT_SETTINGS, vault, fetcher).get('transmart')!

    await expect(provider.translateTable(tableRequest())).rejects.toThrow(/批量响应数量不匹配/)
  })

  it('rejects malformed OpenAI content so the pipeline can use its fallback provider', async () => {
    const keyVault: CredentialVault = {
      ...vault,
      get: async (account) => account === 'qwen-api-key' ? 'fixture-key' : null,
      has: async (account) => account === 'qwen-api-key'
    }
    const fetcher = async (): Promise<Response> => new Response(JSON.stringify({
      choices: [{ message: { content: { unexpected: true } } }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    const provider = createTranslationProviders(DEFAULT_SETTINGS, keyVault, fetcher).get('qwen')!

    await expect(provider.translate('hello')).rejects.toThrow(/无法识别/)
  })

  it('uses short per-segment Bing requests and returns one atomic response', async () => {
    const translatedTexts: string[] = []
    let sessionRequests = 0
    const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      if (url === 'https://www.bing.com/translator') {
        sessionRequests += 1
        return new Response('IG:"fixture-ig"; params_AbusePreventionHelper = [123,"fixture-token"', { status: 200 })
      }
      const body = new URLSearchParams(String(init?.body))
      const source = body.get('text') ?? ''
      translatedTexts.push(source)
      return new Response(JSON.stringify([{ translations: [{ text: `译:${source}` }] }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }
    const request = tableRequest()
    const provider = createTranslationProviders(DEFAULT_SETTINGS, vault, fetcher).get('bing')!
    const response = await provider.translateTable(request)

    expect(sessionRequests).toBe(1)
    expect(translatedTexts).toEqual(flattenSegments(request).map((segment) => segment.text))
    expect(translatedTexts.every((text) => !text.includes('COPILOTIX_SEGMENT'))).toBe(true)
    expect(response.translations).toHaveLength(flattenSegments(request).length)
  })

  it('shares the provider concurrency limit across independently created document jobs', async () => {
    let active = 0
    let peak = 0
    const keyVault: CredentialVault = {
      ...vault,
      get: async (account) => account === 'qwen-api-key' ? 'fixture-key' : null
    }
    const fetcher = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 20))
      active -= 1
      const body = JSON.parse(String(init?.body)) as OpenAiRequestBody
      return new Response(JSON.stringify({ choices: [{ message: { content: `译:${body.messages[0]!.content}` } }] }), { status: 200 })
    }
    const first = createTranslationProviders(DEFAULT_SETTINGS, keyVault, fetcher).get('qwen')!
    const second = createTranslationProviders(DEFAULT_SETTINGS, keyVault, fetcher).get('qwen')!

    await Promise.all(Array.from({ length: 8 }, (_, index) =>
      (index % 2 === 0 ? first : second).translate(`request-${index}`)
    ))

    expect(peak).toBe(3)
  })

  it('applies a shared cooldown after a provider returns HTTP 429', async () => {
    let calls = 0
    const keyVault: CredentialVault = {
      ...vault,
      get: async (account) => account === 'qwen-api-key' ? 'fixture-key' : null
    }
    const fetcher = async (): Promise<Response> => {
      calls += 1
      if (calls === 1) return new Response('', { status: 429, headers: { 'Retry-After': '0' } })
      return new Response(JSON.stringify({ choices: [{ message: { content: '译文' } }] }), { status: 200 })
    }
    const first = createTranslationProviders(DEFAULT_SETTINGS, keyVault, fetcher).get('qwen')!
    const second = createTranslationProviders(DEFAULT_SETTINGS, keyVault, fetcher).get('qwen')!

    await expect(first.translate('limited')).rejects.toMatchObject({ status: 429 })
    const startedAt = Date.now()
    await expect(second.translate('after-limit')).resolves.toBe('译文')

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900)
  })
})
