import type { AppSettings, TranslationProviderId } from './types'

export const MINERU_API_ORIGIN = 'https://mineru.net'
export const MINERU_BATCH_SIZE = 50
export const MAX_PDF_BYTES = 200 * 1024 * 1024
export const CREDENTIAL_SERVICE = 'MinerU-Translation'

export const FALLBACK_PROVIDER_ORDER: TranslationProviderId[] = [
  'qwen',
  'deepseek',
  'bing',
  'transmart'
]

export const DEFAULT_SETTINGS: AppSettings = {
  hasParserToken: false,
  outputRoot: '',
  parserModel: 'vlm',
  forceOcr: false,
  formulaEnabled: true,
  tableEnabled: true,
  ocrLanguage: 'ch',
  translationProvider: 'qwen',
  qwenBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  qwenModel: 'qwen-mt-plus',
  qwenHasApiKey: false,
  deepseekBaseUrl: 'https://api.deepseek.com',
  deepseekModel: 'deepseek-v4-flash',
  deepseekHasApiKey: false
}

export const PROVIDER_LABELS: Record<TranslationProviderId, string> = {
  qwen: '千问',
  deepseek: 'DeepSeek',
  bing: 'Bing',
  transmart: '腾讯 TranSmart'
}
