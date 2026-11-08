import { expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@features/settings/contract/defaultSettings'
import { createTranslationProviders } from '@features/translation/main/providers'
import { ChatProvider } from '@platform/models/main/cloudProvider'
import { sharedModelRuntime } from '@platform/models/runtime/modelRuntime'
import { defaultConnections } from '@platform/models/contract/models'

it('shares one failed connection across translation, chat and background streaming', async () => {
  const settings = structuredClone(DEFAULT_SETTINGS)
  settings.credentials.qwen = { state: 'valid' }
  const fetcher = vi.fn(async () => { throw new TypeError('network unavailable') })
  const providers = createTranslationProviders(settings, { get: async () => 'fixture-key' } as never, fetcher)
  const cloud = new ChatProvider(fetcher)
  const signal = new AbortController().signal
  const results = await Promise.allSettled(Array.from({ length: 50 }, (_, index) => index % 2
    ? providers.get('qwen')!.translate('A paragraph', signal)
    : cloud.stream({ provider: 'qwen', purpose: index % 4 ? 'brief' : 'chat', lane: index % 4 ? 'background' : 'interactive', baseUrl: settings.qwenBaseUrl, model: 'qwen-plus', key: 'fixture-key', messages: [{ role: 'user', content: 'question' }], signal, onDelta: () => undefined })))
  expect(results.every(result => result.status === 'rejected')).toBe(true)
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(sharedModelRuntime.health('qwen:default').status).toBe('cooldown')
})

it('records successful usage once with actual connection identity and no credentials', async () => {
  const observer = vi.fn()
  sharedModelRuntime.onUsage(observer)
  const usage = { promptTokens: 4, completionTokens: 2, totalTokens: 6 }
  try {
    await sharedModelRuntime.execute({ purpose: 'brief', model: 'fixture-model', lane: 'background', candidates: [defaultConnections()[0]!], signal: new AbortController().signal }, async () => ({ value: 'answer', usage }))
    expect(observer).toHaveBeenCalledExactlyOnceWith({ purpose: 'brief', provider: 'qwen', connectionId: 'qwen:default', model: 'fixture-model', usage, completion: 'completed' })
  } finally { sharedModelRuntime.onUsage(() => undefined) }
})
