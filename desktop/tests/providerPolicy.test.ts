import { describe, expect, it } from 'vitest'
import { executableProviderOrder, normalizeEnabledProviders, normalizeProviderOrder } from '@shared/providerPolicy'

describe('translation provider policy', () => {
  it('restores legacy preferred-provider order and rejects malformed stored policies', () => {
    expect(normalizeProviderOrder(undefined, 'deepseek')).toEqual(['deepseek', 'qwen', 'bing', 'transmart'])
    expect(normalizeProviderOrder(['qwen', 'qwen'], 'qwen')).toEqual(['qwen', 'deepseek', 'bing', 'transmart'])
    expect(normalizeEnabledProviders([], ['qwen', 'deepseek', 'bing', 'transmart'])).toEqual(['qwen', 'deepseek', 'bing', 'transmart'])
  })

  it('keeps visual order separate from the executable chain and skips unverified APIs', () => {
    const order = ['deepseek', 'qwen', 'transmart', 'bing'] as const
    expect(executableProviderOrder(order, order, {
      deepseek: { state: 'valid' },
      qwen: { state: 'unknown' }
    })).toEqual(['deepseek', 'transmart', 'bing'])
    expect(executableProviderOrder(order, ['qwen'], {
      deepseek: { state: 'missing' },
      qwen: { state: 'invalid' }
    })).toEqual([])
  })
})
