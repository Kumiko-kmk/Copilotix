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

/** One model key's stored state plus its live runtime health (cooldown until retryAt, or rejected). */
export interface KeyStatus extends CredentialStatus {
  health?: 'cooldown' | 'rejected'
  retryAt?: number
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
  modelConnections?: import('@platform/models/contract/models').ModelConnection[]
  codex?: import('@platform/codex/contract/codex').CodexSettings
  outputRoot: string
  formulaEnabled: boolean
  tableEnabled: boolean
  translationProvider: TranslationProviderId | null
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
  /** qwen/deepseek summarise their enabled keys: valid when any enabled key is valid. */
  credentials: CredentialStatuses
  /** Per-key status by connection id; derived on read, never persisted. */
  keyStatuses?: Record<string, KeyStatus>
}

export interface SettingsUpdate
  extends Omit<AppSettings, 'credentials' | 'keyStatuses'> {
  /** parser, or qwen/deepseek as an alias of that provider's default key. */
  credentialMutations?: Partial<Record<CredentialName, CredentialMutation>>
  keyMutations?: Record<string, CredentialMutation>
}

export interface SettingsSaveResult {
  settings: AppSettings
  fieldErrors: Partial<Record<CredentialName, CredentialFieldError>>
  keyErrors?: Record<string, CredentialFieldError>
}
