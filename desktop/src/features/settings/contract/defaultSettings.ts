import { DEFAULT_CODEX_SETTINGS } from '@platform/codex/contract/codex'
import type { AppSettings } from './settingsTypes'
import { TRANSLATION_PROVIDER_IDS } from '@features/translation/contract/providerPolicy'

export const DEFAULT_SETTINGS: AppSettings = {
  codex: DEFAULT_CODEX_SETTINGS,
  outputRoot: '',
  formulaEnabled: true,
  tableEnabled: true,
  translationProvider: 'qwen',
  translationProviderOrder: [...TRANSLATION_PROVIDER_IDS],
  enabledTranslationProviders: TRANSLATION_PROVIDER_IDS.filter(id => id !== 'codex'),
  qwenBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  qwenModel: 'qwen-mt-plus',
  deepseekBaseUrl: 'https://api.deepseek.com',
  deepseekModel: 'deepseek-flash',
  chatProvider: null,
  autoGeneratePaperInsight: true,
  qwenChatModel: 'qwen-plus',
  deepseekChatModel: 'deepseek-flash',
  chatConsentProvider: null,
  chatConsentVersion: null,
  credentials: {
    parser: { state: 'missing' },
    qwen: { state: 'missing' },
    deepseek: { state: 'missing' }
  }
}
