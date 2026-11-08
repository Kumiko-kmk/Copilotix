import type { ActiveTranslationProviderId, TranslationProviderId } from './translationTypes'

export const TRANSLATION_PROVIDER_IDS = ['qwen', 'deepseek', 'codex'] as const satisfies readonly ActiveTranslationProviderId[]
export const HISTORICAL_TRANSLATION_PROVIDER_IDS = ['qwen', 'deepseek', 'bing', 'transmart', 'codex'] as const
export const isActiveProvider = (value: unknown): value is ActiveTranslationProviderId =>
  typeof value === 'string' && (TRANSLATION_PROVIDER_IDS as readonly string[]).includes(value)

export function providerOrderForPreferred(preferred: TranslationProviderId | null): ActiveTranslationProviderId[] {
  return isActiveProvider(preferred) ? [preferred, ...TRANSLATION_PROVIDER_IDS.filter((provider) => provider !== preferred)] : [...TRANSLATION_PROVIDER_IDS]
}

export function normalizeProviderOrder(value: unknown, preferred: TranslationProviderId | null): ActiveTranslationProviderId[] {
  if (!Array.isArray(value)) return providerOrderForPreferred(preferred)
  const valid = [...new Set(value.filter(isActiveProvider))]
  return [...valid, ...TRANSLATION_PROVIDER_IDS.filter(id => !valid.includes(id))]
}

export function normalizeEnabledProviders(value: unknown, order: readonly TranslationProviderId[]): ActiveTranslationProviderId[] {
  if (!Array.isArray(value)) return order.filter(isActiveProvider).filter(id => id !== 'codex')
  const enabled = order.filter(isActiveProvider).filter((provider) => value.includes(provider))
  return enabled
}

export function executableProviderOrder(
  order: readonly TranslationProviderId[],
  enabled: readonly TranslationProviderId[],
  credentialStates: { qwen: { state: string }; deepseek: { state: string } }
): TranslationProviderId[] {
  const enabledSet = new Set(enabled)
  // Only explicitly enabled, executable connections participate in authorized fallback.
  return order.filter(isActiveProvider).filter((provider) => {
    if (!enabledSet.has(provider)) return false
    if (provider === 'qwen' || provider === 'deepseek') return credentialStates[provider].state === 'valid'
    return true
  })
}

export const TRANSLATION_PROVIDER_LABELS: Record<TranslationProviderId, string> = { codex: 'Codex', deepseek: 'DeepSeek', qwen: 'Qwen', transmart: 'Transmart', bing: 'Bing' }
