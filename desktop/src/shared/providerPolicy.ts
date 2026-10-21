import type { TranslationProviderId } from './types'

export const TRANSLATION_PROVIDER_IDS = ['qwen', 'deepseek', 'bing', 'transmart', 'codex'] as const satisfies readonly TranslationProviderId[]

export function providerOrderForPreferred(preferred: TranslationProviderId): TranslationProviderId[] {
  return [preferred, ...TRANSLATION_PROVIDER_IDS.filter((provider) => provider !== preferred)]
}

export function normalizeProviderOrder(value: unknown, preferred: TranslationProviderId): TranslationProviderId[] {
  if (!Array.isArray(value)) return providerOrderForPreferred(preferred)
  const valid = value.filter((provider): provider is TranslationProviderId =>
    typeof provider === 'string' && TRANSLATION_PROVIDER_IDS.includes(provider as TranslationProviderId))
  if (new Set(valid).size !== valid.length || valid.length !== value.length) return providerOrderForPreferred(preferred)
  return [...valid, ...TRANSLATION_PROVIDER_IDS.filter(id => !valid.includes(id))]
}

export function normalizeEnabledProviders(value: unknown, order: readonly TranslationProviderId[]): TranslationProviderId[] {
  if (!Array.isArray(value)) return order.filter(id => id !== 'codex')
  const enabled = order.filter((provider) => value.includes(provider))
  return enabled.length > 0 ? enabled : order.filter(id => id !== 'codex')
}

export function executableProviderOrder(
  order: readonly TranslationProviderId[],
  enabled: readonly TranslationProviderId[],
  credentialStates: { qwen: { state: string }; deepseek: { state: string } }
): TranslationProviderId[] {
  const enabledSet = new Set(enabled)
  // Blocks that still fail on Codex after its own backoff fall through to the next enabled
  // provider; disabling the others is the switch for Codex-only translation.
  return order.filter((provider) => {
    if (!enabledSet.has(provider)) return false
    if (provider === 'qwen' || provider === 'deepseek') return credentialStates[provider].state === 'valid'
    return true
  })
}

export const TRANSLATION_PROVIDER_LABELS: Record<TranslationProviderId, string> = { codex: 'Codex', deepseek: 'DeepSeek', qwen: 'Qwen', transmart: 'Transmart', bing: 'Bing' }
