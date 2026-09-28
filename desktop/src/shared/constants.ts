import type { AppSettings, TranslationProviderId } from './types'
import { TRANSLATION_PROVIDER_IDS } from './providerPolicy'

export const PARSER_API_ORIGIN = 'https://mineru.net'
export const PARSER_BATCH_SIZE = 50
export const MAX_PDF_BYTES = 200 * 1024 * 1024
export const MAX_PDF_PAGES = 600
export const CREDENTIAL_SERVICE = 'Copilotix-Translation'

export const DEFAULT_SETTINGS: AppSettings = {
  outputRoot: '',
  formulaEnabled: true,
  tableEnabled: true,
  translationProvider: 'qwen',
  translationProviderOrder: [...TRANSLATION_PROVIDER_IDS],
  enabledTranslationProviders: [...TRANSLATION_PROVIDER_IDS],
  qwenBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  qwenModel: 'qwen-mt-plus',
  deepseekBaseUrl: 'https://api.deepseek.com',
  deepseekModel: 'deepseek-flash',
  credentials: {
    parser: { state: 'missing' },
    qwen: { state: 'missing' },
    deepseek: { state: 'missing' }
  }
}

export const PROVIDER_LABELS: Record<TranslationProviderId, string> = {
  qwen: '千问',
  deepseek: 'DeepSeek',
  bing: 'Bing',
  transmart: '腾讯 TranSmart'
}
