import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/constants'
import { createTranslationProviders } from '@main/translation/providers'
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

function tableRequest(): TableTranslationRequest {
  return buildTableTranslationPlan([
    { sourceIndex: 0, markdown: 'Table 1. Results', mappingIds: [] },
    { sourceIndex: 1, markdown: '<table><tr><td>Accuracy</td><td>Recall</td></tr></table>', mappingIds: [] }
  ])!.request
}

describe('table provider transports', () => {
  it('sends the complete v2 JSON request to OpenAI-compatible providers', async () => {
    const requestBodies: any[] = []
    const keyVault: CredentialVault = {
      ...vault,
      get: async (account) => account === 'qwen-api-key' ? 'fixture-key' : null,
      has: async (account) => account === 'qwen-api-key'
    }
    const fetcher = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body))
      requestBodies.push(body)
      const request = JSON.parse(body.messages[1].content) as TableTranslationRequest
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
    const provider = createTranslationProviders(DEFAULT_SETTINGS, keyVault, fetcher).get('qwen')!
    const response = await provider.translateTable(request)

    expect(requestBodies).toHaveLength(1)
    expect(requestBodies[0].messages[1].content).toContain('mineru-table-translation-v2')
    expect(requestBodies[0].messages[1].content).toContain('Table 1. Results')
    expect(response.translations).toHaveLength(flattenSegments(request).length)
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
    expect(translatedTexts.every((text) => !text.includes('MINERU_SEGMENT'))).toBe(true)
    expect(response.translations).toHaveLength(flattenSegments(request).length)
  })
})
