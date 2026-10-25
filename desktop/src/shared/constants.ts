import { DEFAULT_CODEX_SETTINGS } from '@platform/codex/contract/codex'
import type { AppSettings } from './types'
import { TRANSLATION_PROVIDER_IDS } from './providerPolicy'

export const PARSER_API_ORIGIN = 'https://mineru.net'
export const MAX_PDF_BYTES = 200 * 1024 * 1024
export const MAX_PDF_PAGES = 600

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
