import React from 'react'
import { Button, Input, Switch } from 'antd'
import { createConnection, type KeyProvider, type ModelConnection } from '@platform/models/contract/models'
import { DEFAULT_CODEX_SETTINGS, type CodexSettings } from '@platform/codex/contract/codex'
import type { AppSettings, CredentialStatus, CredentialValidation, KeyStatus } from '../contract/settingsTypes'
import type { ActiveTranslationProviderId } from '@features/translation/contract/translationTypes'
import type { DraftCredential } from './CredentialEditor'
import type { KeyDrafts } from './ApiKeysSection'
import { loadCachedCodexStatus, refreshCodexStatus, useCodexStatus } from './codexStatusClient'
import { DeleteIcon } from './settingsIcons'

const STATE_LABELS: Record<CredentialValidation, string> = { missing: '未配置', unknown: '待驗證', valid: '已驗證', invalid: '驗證失敗' }
const NAMES: Record<ActiveTranslationProviderId, string> = { deepseek: 'DeepSeek', qwen: '千問', codex: 'Codex' }

type RowState = { state: CredentialValidation; label: string }

/**
 * Lite's single 服務 page: one row per service with its key, a test, and whether translation uses it.
 * No sub-pages, no explanations: one key per provider, Codex detected on its own.
 */
export function LiteServices(props: {
  draft: AppSettings
  onDraftChange(update: (current: AppSettings) => AppSettings): void
  parser: { status: CredentialStatus; draft: DraftCredential; testing: boolean; error?: string; onDraft(patch: Partial<DraftCredential>): void; onValidate(): void }
  keys: KeyDrafts
  saving: boolean
  onToggleProvider(provider: ActiveTranslationProviderId): void
}): React.JSX.Element {
  const { draft, parser, keys } = props
  const parserState: RowState = parser.error ? { state: 'invalid', label: STATE_LABELS.invalid } : rowState(parser.status.state, parser.draft.editing && Boolean(parser.draft.value.trim()))
  const providers = draft.translationProviderOrder.filter((provider): provider is ActiveTranslationProviderId => provider in NAMES)
  return (
    <section className="settings-section lite-services" aria-label="服務">
      <ServiceRow name="MinerU" state={parser.draft.clear ? { state: 'missing', label: '將刪除' } : parserState}>
        <Input.Password aria-label="MinerU Token" autoComplete="new-password" visibilityToggle={false}
          placeholder={parser.status.state !== 'missing' && !parser.draft.clear ? parser.status.maskedValue ?? '已儲存' : '貼上 Token'}
          value={parser.draft.editing ? parser.draft.value : ''}
          onChange={(event) => parser.onDraft({ editing: true, value: event.target.value, clear: false })} />
        <Button loading={parser.testing} disabled={parser.draft.clear || (parser.status.state === 'missing' && !parser.draft.value.trim())} onClick={parser.onValidate}>測試</Button>
        <Button type="text" aria-label="刪除 MinerU Token" icon={<DeleteIcon />} disabled={parser.status.state === 'missing' && !parser.draft.value}
          onClick={() => parser.onDraft({ editing: true, value: '', clear: true })} />
      </ServiceRow>
      {providers.map((provider) => provider === 'codex'
        ? <CodexRow key={provider} value={draft.codex} enabled={draft.enabledTranslationProviders.includes(provider)} disabled={props.saving}
            onChange={(codex) => props.onDraftChange((current) => ({ ...current, codex }))} onToggle={() => props.onToggleProvider(provider)} />
        : <KeyRow key={provider} provider={provider} draft={draft} keys={keys} saving={props.saving}
            enabled={draft.enabledTranslationProviders.includes(provider)} onToggle={() => props.onToggleProvider(provider)}
            onConnectionsChange={(connections) => props.onDraftChange((current) => ({ ...current, modelConnections: connections }))} />)}
    </section>
  )
}

function ServiceRow(props: { name: string; state: RowState; toggle?: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="lite-service" data-service={props.name}>
      <span className="lite-service-name">{props.name}</span>
      <div className="lite-service-control">{props.children}</div>
      <span className={`credential-status status-${props.state.state}`}>{props.state.label}</span>
      <span className="lite-service-toggle">{props.toggle}</span>
    </div>
  )
}

function TranslationSwitch(props: { name: string; enabled: boolean; disabled: boolean; onToggle(): void }): React.JSX.Element {
  return <Switch size="small" aria-label={`用${props.name}翻譯`} checked={props.enabled} disabled={props.disabled} onChange={props.onToggle} />
}

function rowState(state: CredentialValidation, pending: boolean): RowState {
  return pending ? { state: 'unknown', label: '待儲存' } : { state, label: STATE_LABELS[state] }
}

/** The provider's first key; editing a provider without one creates its default connection. */
function KeyRow(props: {
  provider: KeyProvider
  draft: AppSettings
  keys: KeyDrafts
  saving: boolean
  enabled: boolean
  onToggle(): void
  onConnectionsChange(connections: ModelConnection[]): void
}): React.JSX.Element {
  const { provider, keys } = props
  const connections = props.draft.modelConnections ?? []
  const connection = connections.find((candidate) => candidate.provider === provider)
  const id = connection?.connectionId ?? `${provider}:default`
  const stored: Partial<KeyStatus> = { ...props.draft.keyStatuses?.[id], ...keys.live[id] }
  const value = keys.values[id]
  const hasStored = Boolean(connection && props.draft.keyStatuses?.[id] && stored.state !== 'missing')
  const state: RowState = keys.errors[id] || stored.health === 'rejected' ? { state: 'invalid', label: STATE_LABELS.invalid }
    : rowState(hasStored ? stored.state ?? 'unknown' : 'missing', Boolean(value?.trim()))
  const ensure = (): ModelConnection => {
    if (connection) return connection
    const created = createConnection(provider, id, connections.length)
    props.onConnectionsChange([...connections, created])
    return created
  }
  return (
    <ServiceRow name={NAMES[provider]} state={state}
      toggle={<TranslationSwitch name={NAMES[provider]} enabled={props.enabled} disabled={props.saving} onToggle={props.onToggle} />}>
      <Input.Password aria-label={`${NAMES[provider]} API Key`} autoComplete="new-password" visibilityToggle={false}
        placeholder={hasStored ? stored.maskedValue ?? '已儲存' : '貼上 API Key'} value={value ?? ''}
        onChange={(event) => { ensure(); keys.setValue(id, event.target.value || undefined) }} />
      <Button loading={keys.testing === id} disabled={props.saving || (!hasStored && !value?.trim())} onClick={() => void keys.validate(ensure())}>測試</Button>
      <Button type="text" aria-label={`刪除 ${NAMES[provider]} API Key`} icon={<DeleteIcon />} disabled={props.saving || (!hasStored && !value)}
        onClick={() => { keys.setValue(id, undefined); props.onConnectionsChange(connections.filter((candidate) => candidate.connectionId !== id)) }} />
    </ServiceRow>
  )
}

/** Codex runs from the local install: detection finds the program and picks its default model. */
function CodexRow(props: { value?: CodexSettings; enabled: boolean; disabled: boolean; onChange(value: CodexSettings): void; onToggle(): void }): React.JSX.Element {
  const value = props.value ?? DEFAULT_CODEX_SETTINGS
  const status = useCodexStatus(value)
  const [busy, setBusy] = React.useState(false)
  const [failed, setFailed] = React.useState(false)
  const mounted = React.useRef(true)
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  React.useEffect(() => { void loadCachedCodexStatus(value) }, [value.executable, value.effort])
  const { onChange } = props
  const detect = async (): Promise<void> => {
    setBusy(true); setFailed(false)
    try {
      const result = await refreshCodexStatus(value)
      if (!mounted.current || result.state !== 'ready') return
      const model = result.models.find((candidate) => candidate.isDefault)?.id ?? result.models[0]?.id ?? ''
      const usable = (id: string): boolean => result.models.some((candidate) => candidate.id === id)
      onChange({ ...value, executable: result.executable, translationModel: usable(value.translationModel) ? value.translationModel : model, chatModel: usable(value.chatModel) ? value.chatModel : model })
    } catch { if (mounted.current) setFailed(true) }
    finally { if (mounted.current) setBusy(false) }
  }
  const choose = async (): Promise<void> => {
    const executable = await window.copilotix.codex.selectExecutable().catch(() => null)
    if (executable && mounted.current) onChange({ ...value, executable })
  }
  const ready = status?.state === 'ready'
  const state: RowState = failed ? { state: 'invalid', label: '檢測失敗' }
    : ready ? { state: 'valid', label: '已登入' }
      : status?.state === 'signed-out' ? { state: 'invalid', label: '未登入' }
        : status ? { state: 'missing', label: '未找到' } : { state: 'unknown', label: '未檢測' }
  const model = status?.models.find((candidate) => candidate.id === value.translationModel)?.name
  return (
    <ServiceRow name="Codex" state={state}
      toggle={<TranslationSwitch name="Codex" enabled={props.enabled} disabled={props.disabled} onToggle={props.onToggle} />}>
      <Input aria-label="Codex" readOnly value={ready ? [model, status.version].filter(Boolean).join(' · ') : ''} placeholder="本機 Codex" />
      <Button loading={busy} onClick={() => void detect()}>檢測</Button>
      {status && status.state === 'missing' ? <Button onClick={() => void choose()}>選擇程式</Button> : null}
    </ServiceRow>
  )
}
