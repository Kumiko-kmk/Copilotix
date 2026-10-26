import { type TranslationProviderId } from '@features/translation/contract/translationTypes'

/** Settings and credential status shapes (API keys themselves never leave the platform vault). */

export type CredentialName = 'parser' | 'qwen' | 'deepseek'
export type CredentialValidation = 'missing' | 'unknown' | 'valid' | 'invalid'

export type CredentialMutation =
  | { action: 'set'; value: string }
  | { action: 'clear' }

export interface CredentialValidationResult {
  state: CredentialValidation
  errorCode?: string
  message?: string
}

export interface CredentialStatus extends CredentialValidationResult {
  maskedValue?: string
}

export interface CredentialStatuses {
  parser: CredentialStatus
  qwen: CredentialStatus
  deepseek: CredentialStatus
}

export interface CredentialFieldError {
  code: string
  message: string
}

export interface AppSettings {
  codex?: import('@platform/codex/contract/codex').CodexSettings
  outputRoot: string
  formulaEnabled: boolean
  tableEnabled: boolean
  translationProvider: TranslationProviderId
  translationProviderOrder: TranslationProviderId[]
  enabledTranslationProviders: TranslationProviderId[]
  qwenBaseUrl: string
  qwenModel: string
  deepseekBaseUrl: string
  deepseekModel: string
  /** Legacy persisted field, ignored by chat routing; use translationProvider. */
  chatProvider: 'qwen' | 'deepseek' | 'codex' | null
  autoGeneratePaperInsight: boolean
  qwenChatModel: string
  deepseekChatModel: string
  chatConsentProvider: 'qwen' | 'deepseek' | 'codex' | null
  chatConsentVersion: number | null
  credentials: CredentialStatuses
}

export interface SettingsUpdate
  extends Omit<AppSettings, 'credentials'> {
  credentialMutations?: Partial<Record<CredentialName, CredentialMutation>>
}

export interface SettingsSaveResult {
  settings: AppSettings
  fieldErrors: Partial<Record<CredentialName, CredentialFieldError>>
}
