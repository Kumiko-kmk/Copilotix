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
  const result = order.filter((provider) => {
    if (!enabledSet.has(provider)) return false
    if (provider === 'qwen' || provider === 'deepseek') return credentialStates[provider].state === 'valid'
    return true
  })
  // Codex is an explicit privacy boundary: do not fall through to another provider.
  const codexIndex = result.indexOf('codex')
  return codexIndex < 0 ? result : result.slice(0, codexIndex + 1)
}
