import type { AppSettings, TranslationProviderId } from './types'

export const API_PROTOCOL_VERSION = '2'
export const CREDENTIAL_SERVICE = 'MinerU-Translation'

export const FALLBACK_PROVIDER_ORDER: TranslationProviderId[] = [
  'qwen',
  'deepseek',
  'bing',
  'transmart'
]

export const DEFAULT_SETTINGS: AppSettings = {
  parserBaseUrl: 'http://127.0.0.1:8000',
  hasParserToken: false,
  outputRoot: '',
  parserModel: 'hybrid-engine',
  parserEffort: 'medium',
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
