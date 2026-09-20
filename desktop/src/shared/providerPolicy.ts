import type { TranslationProviderId } from './types'

export const TRANSLATION_PROVIDER_IDS = ['qwen', 'deepseek', 'bing', 'transmart'] as const satisfies readonly TranslationProviderId[]

export function providerOrderForPreferred(preferred: TranslationProviderId): TranslationProviderId[] {
  return [preferred, ...TRANSLATION_PROVIDER_IDS.filter((provider) => provider !== preferred)]
}

export function normalizeProviderOrder(value: unknown, preferred: TranslationProviderId): TranslationProviderId[] {
  if (!Array.isArray(value) || value.length !== TRANSLATION_PROVIDER_IDS.length) return providerOrderForPreferred(preferred)
  const order = value.filter((provider): provider is TranslationProviderId =>
    typeof provider === 'string' && TRANSLATION_PROVIDER_IDS.includes(provider as TranslationProviderId))
  return order.length === TRANSLATION_PROVIDER_IDS.length && new Set(order).size === TRANSLATION_PROVIDER_IDS.length
    ? order
    : providerOrderForPreferred(preferred)
}

export function normalizeEnabledProviders(value: unknown, order: readonly TranslationProviderId[]): TranslationProviderId[] {
  if (!Array.isArray(value)) return [...order]
  const enabled = order.filter((provider) => value.includes(provider))
  return enabled.length > 0 ? enabled : [...order]
}

export function executableProviderOrder(
  order: readonly TranslationProviderId[],
  enabled: readonly TranslationProviderId[],
  credentialStates: { qwen: { state: string }; deepseek: { state: string } }
): TranslationProviderId[] {
  const enabledSet = new Set(enabled)
  return order.filter((provider) => {
    if (!enabledSet.has(provider)) return false
    if (provider === 'qwen' || provider === 'deepseek') return credentialStates[provider].state === 'valid'
    return true
  })
}
