import React from 'react'
import { isActiveProvider } from '@features/translation/contract/providerPolicy'
import { cachedStorageInfo, loadStorageInfo } from './storageInfoClient'
import { HolderOutlined } from '@ant-design/icons'
import { Button, Checkbox, Typography, message } from 'antd'
import type {
  AppSettings,
  CredentialMutation,
  CredentialName,
  CredentialValidation,
  SettingsUpdate
} from '../contract/settingsTypes'
import type { ActiveTranslationProviderId } from '@features/translation/contract/translationTypes'
import type { StorageInfo, UsageAnalytics } from '../contract/settingsSchemas'
import { UsageDashboard } from './SettingsDashboards'
import { StorageSettings, type LibraryAction } from './StorageSettings'
import { CredentialEditor, initialCredentialDraft, type DraftCredential } from './CredentialEditor'
import { AppearanceIcon, CloseIcon, ConnectionIcon, KeyIcon, ModelIcon, StorageIcon } from './settingsIcons'
import { LiteServices } from './LiteServices'
import ThemeSettings from './ThemeSettings'
import { previewAppearance, saveAppearance, storedAppearance, type Appearance } from './theme'
import { CodexSettingsCard } from './CodexSettingsCard'
import { ServiceCard } from './ServiceCard'
import { ApiKeysSection, useKeyDrafts } from './ApiKeysSection'
import './settings.css'
import type { SettingsNavigationGuard } from './settingsNavigation'

type Section = 'connections' | 'keys' | 'models' | 'storage' | 'theme' | 'services'

const SECTIONS: ReadonlyArray<[Section, string, () => React.JSX.Element]> = [
  ['connections', '服務連線', ConnectionIcon],
  ['keys', 'API 金鑰', KeyIcon],
  ['models', '模型設定', ModelIcon],
  ['storage', '檔案儲存', StorageIcon],
  ['theme', '顯示設定', AppearanceIcon]
]
/** The settings window (Lite) has three flat sections; services and their keys share one page. */
const WINDOW_SECTIONS: ReadonlyArray<[Section, string, () => React.JSX.Element]> = [
  ['services', '服務', ConnectionIcon],
  ['storage', '儲存', StorageIcon],
  ['theme', '外觀', AppearanceIcon]
]

/** Only the MinerU token is edited here; model keys are managed in the API key view. */
type DraftCredentials = Record<'parser', DraftCredential>
type CredentialErrors = Partial<Record<CredentialName, string>>

const CREDENTIAL_LABELS: Record<'parser', string> = { parser: 'MinerU 解析 Token' }

const STATUS_LABELS: Record<CredentialValidation, string> = {
  missing: '未配置',
  unknown: '待驗證',
  valid: '已驗證',
  invalid: '驗證失敗'
}

const MODEL_LABELS: Record<ActiveTranslationProviderId, string> = {
  codex: 'Codex',
  deepseek: 'DeepSeek',
  qwen: '千問 / Qwen'
}

export default function SettingsPage(props: {
  settings: AppSettings
  onSaved(settings: AppSettings): void
  onNavigationGuardChange?(guard: SettingsNavigationGuard | null): void
  /** Settings in a window over the app: a close button, and only what is needed on each section. */
  onExit?(): void
}): React.JSX.Element {
  const windowed = Boolean(props.onExit)
  const sections = windowed ? WINDOW_SECTIONS : SECTIONS
  const [section, setSection] = React.useState<Section>(windowed ? 'services' : 'connections')
  const [draft, setDraft] = React.useState<AppSettings>(props.settings)
  const [credentials, setCredentials] = React.useState<DraftCredentials>(() => initialCredentials(props.settings))
  const [credentialErrors, setCredentialErrors] = React.useState<CredentialErrors>({})
  const [testing, setTesting] = React.useState<CredentialName | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [storageInfo, setStorageInfo] = React.useState<StorageInfo | null>(() => cachedStorageInfo(props.settings.outputRoot))
  const [usageAnalytics, setUsageAnalytics] = React.useState<UsageAnalytics | null>(null)
  const [storageLoading, setStorageLoading] = React.useState(false)
  const [libraryAction, setLibraryAction] = React.useState<LibraryAction | null>(null)
  const libraryActionRef = React.useRef(false)
  const [draggingProvider, setDraggingProvider] = React.useState<ActiveTranslationProviderId | null>(null)
  const previousSettingsRef = React.useRef(props.settings)
  const [messageApi, contextHolder] = message.useMessage()
  const keyDrafts = useKeyDrafts(messageApi)
  const { mutations: keyMutationsFor, applySaveResult: applyKeyResult, reset: resetKeyDrafts } = keyDrafts

  React.useEffect(() => {
    const previous = previousSettingsRef.current
    setDraft((current) => ({
      ...props.settings,
      codex: JSON.stringify(current.codex) !== JSON.stringify(previous.codex) ? current.codex : props.settings.codex,
      outputRoot: current.outputRoot !== previous.outputRoot ? current.outputRoot : props.settings.outputRoot,
      formulaEnabled: current.formulaEnabled !== previous.formulaEnabled ? current.formulaEnabled : props.settings.formulaEnabled,
      tableEnabled: current.tableEnabled !== previous.tableEnabled ? current.tableEnabled : props.settings.tableEnabled,
      qwenBaseUrl: current.qwenBaseUrl !== previous.qwenBaseUrl ? current.qwenBaseUrl : props.settings.qwenBaseUrl,
      qwenModel: current.qwenModel !== previous.qwenModel ? current.qwenModel : props.settings.qwenModel,
      deepseekBaseUrl: current.deepseekBaseUrl !== previous.deepseekBaseUrl ? current.deepseekBaseUrl : props.settings.deepseekBaseUrl,
      deepseekModel: current.deepseekModel !== previous.deepseekModel ? current.deepseekModel : props.settings.deepseekModel,
      modelConnections: JSON.stringify(current.modelConnections) !== JSON.stringify(previous.modelConnections) ? current.modelConnections : props.settings.modelConnections
    }))
    setCredentials((current) => {
      const next = initialCredentials(props.settings)
      // A partial credential save can update the parent settings while another
      // field is still being edited. Keep those local drafts so a failed
      // candidate is not silently replaced by its masked server value.
      if (current.parser.editing || current.parser.clear) next.parser = current.parser
      return next
    })
    previousSettingsRef.current = props.settings
  }, [props.settings])

  const updateCredentialDraft = React.useCallback((name: CredentialName, patch: Partial<DraftCredential>) => {
    setCredentialErrors((current) => ({ ...current, [name]: undefined }))
    setCredentials((current) => ({ ...current, [name]: { ...current[name], ...patch } }))
  }, [])

  const refreshStorageInfo = React.useCallback(async () => {
    setStorageLoading(true)
    try {
      setStorageInfo(await loadStorageInfo(props.settings.outputRoot, true))
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : String(error))
    } finally {
      setStorageLoading(false)
    }
  }, [messageApi, props.settings.outputRoot])

  const runLibraryAction = React.useCallback(async (action: LibraryAction) => {
    if (libraryActionRef.current) return
    libraryActionRef.current = true
    setLibraryAction(action)
    try {
      const result = await window.copilotix.manageLibrary({ action })
      if (result.status === 'cancelled') { messageApi.info('文件庫操作已取消'); return }
      if (result.restartRequired) {
        messageApi.success('文件庫操作完成，應用即將重啟')
        return
      }
      messageApi.success('備份完成：' + result.path)
      await refreshStorageInfo()
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : String(error))
    } finally {
      libraryActionRef.current = false
      setLibraryAction(null)
    }
  }, [messageApi, refreshStorageInfo])

  const openStorageLocation = React.useCallback(async () => {
    try {
      await window.copilotix.openStorageLocation()
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : String(error))
    }
  }, [messageApi])

  React.useEffect(() => {
    if (section !== 'storage') return
    let active = true
    setStorageInfo(cachedStorageInfo(props.settings.outputRoot))
    void loadStorageInfo(props.settings.outputRoot).then(value => { if (active) setStorageInfo(value) }).catch(() => undefined)
    return () => { active = false }
  }, [props.settings.outputRoot, section])

  // Key health (cooldown, rejection) changes while the app runs; refresh it whenever the key view opens.
  const setLiveKeys = keyDrafts.setLive
  React.useEffect(() => {
    if (section !== 'keys' && section !== 'services') return
    let active = true
    void window.copilotix.getSettings().then(settings => { if (active) setLiveKeys(settings.keyStatuses ?? {}) }).catch(() => undefined)
    return () => { active = false }
  }, [section, setLiveKeys])

  // The window shows no usage charts, so it does not ask for them.
  React.useEffect(() => {
    if (section !== 'connections' || windowed) return
    let active = true
    void window.copilotix.getUsageAnalytics()
      .then((analytics) => { if (active) setUsageAnalytics(analytics) })
      .catch(() => { if (active) setUsageAnalytics(null) })
    return () => { active = false }
  }, [section, props.settings, windowed])

  const validate = React.useCallback(async (name: 'parser') => {
    const entry = credentials[name]
    const value = entry.editing ? entry.value.trim() : undefined
    if (entry.editing && !value) {
      setCredentialErrors((current) => ({ ...current, [name]: '請輸入憑據後再驗證' }))
      return
    }
    setTesting(name)
    try {
      const result = await window.copilotix.validateCredential(name, value)
      setDraft((current) => ({
        ...current,
        credentials: {
          ...current.credentials,
          [name]: {
            ...current.credentials[name],
            ...result
          }
        }
      }))
      if (result.state === 'valid') {
        setCredentialErrors((current) => ({ ...current, [name]: undefined }))
        messageApi.success(`${CREDENTIAL_LABELS[name]}驗證成功`)
      } else {
        const error = result.message ?? '憑據驗證失敗'
        setCredentialErrors((current) => ({ ...current, [name]: error }))
        messageApi.error(error)
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      setCredentialErrors((current) => ({ ...current, [name]: text }))
      messageApi.error(text)
    } finally {
      setTesting(null)
    }
  }, [credentials, messageApi])

  // Appearance previews at once and is saved or reverted with the rest of the page.
  const [appearance, setAppearance] = React.useState<Appearance>(storedAppearance)
  const [savedAppearance, setSavedAppearance] = React.useState<Appearance>(storedAppearance)
  const appearanceChanged = appearance.themeId !== savedAppearance.themeId || appearance.readerFontSize !== savedAppearance.readerFontSize ||
    appearance.readerLineHeight !== savedAppearance.readerLineHeight
  const changeAppearance = React.useCallback((next: Appearance) => {
    setAppearance(next)
    previewAppearance(next)
  }, [])
  // Leaving without saving (or closing the window) never keeps a previewed appearance.
  React.useEffect(() => () => previewAppearance(storedAppearance()), [])

  const settingsChanged = React.useMemo(() => {
    const { credentials: _draftCredentials, keyStatuses: _draftKeys, ...draftSettings } = draft
    const { credentials: _savedCredentials, keyStatuses: _savedKeys, ...savedSettings } = props.settings
    const publicSettingsChanged = JSON.stringify(draftSettings) !== JSON.stringify(savedSettings)
    const credentialsChanged = credentials.parser.clear || Boolean(credentials.parser.value.trim())
    return publicSettingsChanged || credentialsChanged || keyDrafts.dirty
  }, [credentials, draft, keyDrafts.dirty, props.settings])

  const save = React.useCallback(async (): Promise<boolean> => {
    if (appearanceChanged) {
      // Local and infallible, so it is kept even if the settings below fail to save.
      saveAppearance(appearance)
      setSavedAppearance(appearance)
      if (!settingsChanged) {
        messageApi.success('設定已儲存')
        return true
      }
    }
    setSaving(true)
    try {
      const credentialMutations: Partial<Record<CredentialName, CredentialMutation>> = {}
      if (credentials.parser.clear) credentialMutations.parser = { action: 'clear' }
      else if (credentials.parser.editing && credentials.parser.value.trim()) credentialMutations.parser = { action: 'set', value: credentials.parser.value }

      const { credentials: _credentials, keyStatuses: _keyStatuses, ...publicSettings } = draft
      const sent = draft.modelConnections ?? []
      const keyMutations = keyMutationsFor(sent)
      const payload: SettingsUpdate = {
        ...publicSettings,
        ...(Object.keys(credentialMutations).length > 0 ? { credentialMutations } : {}),
        ...(keyMutations ? { keyMutations } : {})
      }
      const result = await window.copilotix.saveSettings(payload)
      const modelConnections = applyKeyResult(sent, result)
      props.onSaved(result.settings)
      setDraft({ ...result.settings, modelConnections })
      if (section === 'storage') void refreshStorageInfo()
      const errors: CredentialErrors = {}
      for (const [name, fieldError] of Object.entries(result.fieldErrors) as Array<[CredentialName, { message: string } | undefined]>) {
        if (fieldError) errors[name] = fieldError.message
      }
      setCredentialErrors(errors)
      setCredentials((current) => errors.parser || !(current.parser.editing || current.parser.clear)
        ? current
        : { parser: { value: '', editing: false, clear: false } })
      const failed = Object.keys(errors).length + Object.keys(result.keyErrors ?? {}).length
      if (failed > 0) messageApi.warning('普通設定及有效憑據已儲存，請修正失敗欄位')
      else messageApi.success('設定已儲存')
      return failed === 0
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      setSaving(false)
    }
  }, [appearance, appearanceChanged, applyKeyResult, credentials, draft, keyMutationsFor, messageApi, props.onSaved, refreshStorageInfo, section, settingsChanged])

  const moveProvider = React.useCallback((source: ActiveTranslationProviderId, target: ActiveTranslationProviderId) => {
    setDraft((current) => {
      const order = moveProviderBefore(current.translationProviderOrder.filter(isActiveProvider), source, target)
      return {
        ...current,
        translationProvider: order.find((provider) => current.enabledTranslationProviders.includes(provider)) ?? null,
        translationProviderOrder: order
      }
    })
  }, [])

  const finishProviderDrag = React.useCallback(() => {
    if (!draggingProvider) return
    setDraggingProvider(null)
  }, [draggingProvider])

  const toggleTranslationProvider = React.useCallback((provider: ActiveTranslationProviderId) => {
    const enabled = draft.enabledTranslationProviders.includes(provider)
    setDraft((current) => {
      const next = enabled
        ? current.enabledTranslationProviders.filter((candidate) => candidate !== provider)
        : [...current.enabledTranslationProviders, provider]
      return {
        ...current,
        translationProvider: current.translationProviderOrder.find((candidate) => next.includes(candidate)) ?? null,
        enabledTranslationProviders: next
      }
    })
  }, [draft.enabledTranslationProviders])

  const moveProviderByKeyboard = React.useCallback((provider: ActiveTranslationProviderId, direction: -1 | 1) => {
    const index = draft.translationProviderOrder.indexOf(provider)
    const targetIndex = index + direction
    if (index < 0 || targetIndex < 0 || targetIndex >= draft.translationProviderOrder.length) return
    const next = [...draft.translationProviderOrder]
    ;[next[index], next[targetIndex]] = [next[targetIndex]!, next[index]!]
    setDraft((current) => ({
      ...current,
      translationProvider: next.find((candidate) => current.enabledTranslationProviders.includes(candidate)) ?? null,
      translationProviderOrder: next
    }))
  }, [draft.translationProviderOrder])

  const hasUnsavedChanges = settingsChanged || appearanceChanged
  const keySummary = React.useMemo(() => {
    const keys = draft.modelConnections ?? []
    const count = (provider: 'qwen' | 'deepseek'): number => keys.filter((connection) => connection.provider === provider).length
    const states = [draft.credentials.deepseek.state, draft.credentials.qwen.state]
    const state: CredentialValidation = states.includes('valid') ? 'valid' : states.includes('unknown') ? 'unknown' : states.includes('invalid') ? 'invalid' : 'missing'
    return { state, label: STATUS_LABELS[state], counts: `DeepSeek ${count('deepseek')} 個 · 千問 ${count('qwen')} 個` }
  }, [draft.credentials, draft.modelConnections])

  const discard = React.useCallback(() => {
    setDraft(props.settings)
    setCredentials(initialCredentials(props.settings))
    setCredentialErrors({})
    resetKeyDrafts()
    setAppearance(savedAppearance)
    previewAppearance(savedAppearance)
  }, [props.settings, resetKeyDrafts, savedAppearance])

  const onNavigationGuardChange = props.onNavigationGuardChange
  React.useLayoutEffect(() => {
    onNavigationGuardChange?.({ dirty: hasUnsavedChanges, busy: saving || testing !== null || keyDrafts.testing !== null || libraryAction !== null, save, discard })
  }, [onNavigationGuardChange, hasUnsavedChanges, saving, testing, keyDrafts.testing, libraryAction, save, discard])
  React.useLayoutEffect(() => () => onNavigationGuardChange?.(null), [onNavigationGuardChange])

  return (
    <section className={`page settings-page${windowed ? ' is-window' : ''}`}>
      {contextHolder}
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="設定分類">
          <h1 className="settings-title">設定</h1>
          {sections.map(([id, label, SectionIcon]) => (
            <button key={id} type="button" className={section === id ? 'active' : ''} aria-current={section === id ? 'page' : undefined} onClick={() => setSection(id)}><SectionIcon />{label}</button>
          ))}
        </nav>
        <div className="settings-content">
          {props.onExit ? (
            <header className="settings-window-header">
              <h2>{sections.find(([id]) => id === section)![1]}</h2>
              <button type="button" className="settings-close" aria-label="關閉設定" onClick={props.onExit}><CloseIcon /></button>
            </header>
          ) : null}
          <div className="settings-content-body">
          {section === 'services' ? (
            <LiteServices draft={draft} onDraftChange={setDraft} keys={keyDrafts} saving={saving} onToggleProvider={toggleTranslationProvider}
              parser={{ status: draft.credentials.parser, draft: credentials.parser, testing: testing === 'parser', error: credentialErrors.parser, onDraft: (patch) => updateCredentialDraft('parser', patch), onValidate: () => void validate('parser') }} />
          ) : null}
          {section === 'connections' ? (
            <section className="settings-section service-connections" aria-label="服務連線">
              <ServiceCard
                title="MinerU"
                name="parser"
                state={draft.credentials.parser.state}
                stateLabel={draft.credentials.parser.message ?? STATUS_LABELS[draft.credentials.parser.state]}
              >
                <CredentialEditor
                  name="parser"
                  status={draft.credentials.parser}
                  draft={credentials.parser}
                  error={credentialErrors.parser}
                  testing={testing === 'parser'}
                  onDraft={(patch) => updateCredentialDraft('parser', patch)}
                  onValidate={() => void validate('parser')}
                />
              </ServiceCard>
              <ServiceCard
                title="模型金鑰"
                name="model-keys"
                state={keySummary.state}
                stateLabel={keySummary.label}
              >
                <div className="model-key-summary">
                  <span>{keySummary.counts}</span>
                  <Button onClick={() => setSection('keys')}>管理金鑰</Button>
                </div>
              </ServiceCard>
              <CodexSettingsCard value={draft.codex} onChange={codex => setDraft(current => ({ ...current, codex }))} />
              {windowed ? null : <UsageDashboard analytics={usageAnalytics} />}
            </section>
          ) : null}
          {section === 'keys' ? (
            <ApiKeysSection
              connections={(draft.modelConnections ?? []).filter((connection) => connection.provider !== 'codex')}
              statuses={draft.keyStatuses ?? {}}
              drafts={keyDrafts}
              saving={saving}
              onChange={(keys) => setDraft((current) => ({ ...current, modelConnections: [...keys, ...(current.modelConnections ?? []).filter((connection) => connection.provider === 'codex')] }))}
            />
          ) : null}
          {section === 'models' ? (
            <section className="settings-section model-priority" aria-label="模型設定">
              <div className="model-priority-card">
                <div className="model-priority-heading"><strong>大語言模型優先順序</strong><span className="model-request-order"><span>請求順序</span><strong>{draft.translationProviderOrder.filter((provider) => draft.enabledTranslationProviders.includes(provider)).filter(isActiveProvider).map((provider) => MODEL_LABELS[provider].replace(' / Qwen', '')).join(' → ') || '未配置'}</strong></span></div>
                <div className="model-priority-list" role="list" aria-label="翻譯模型優先順序">
                  {draft.translationProviderOrder.filter(isActiveProvider).map((provider, index) => {
                    const label = MODEL_LABELS[provider]
                    const credentialStatus = provider === 'qwen' || provider === 'deepseek' ? draft.credentials[provider] : null
                    return (
                      <div
                        className={`model-priority-item${draggingProvider === provider ? ' dragging' : ''}`}
                        data-provider={provider}
                        role="listitem"
                        key={provider}
                        onDragEnter={(event) => {
                          event.preventDefault()
                          if (draggingProvider && draggingProvider !== provider) moveProvider(draggingProvider, provider)
                        }}
                        onDragOver={(event) => event.preventDefault()}
                      >
                        <button
                          type="button"
                          className="model-drag-handle"
                          aria-label={`移動${label}`}
                          draggable={!saving}
                          disabled={saving}
                          onDragStart={(event) => {
                            event.dataTransfer.effectAllowed = 'move'
                            setDraggingProvider(provider)
                          }}
                          onDragEnd={finishProviderDrag}
                          onKeyDown={(event) => {
                            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
                            event.preventDefault()
                            moveProviderByKeyboard(provider, event.key === 'ArrowUp' ? -1 : 1)
                          }}
                        ><HolderOutlined /></button>
                        <Checkbox
                          aria-label={`啟用${label}`}
                          checked={draft.enabledTranslationProviders.includes(provider)}
                          disabled={saving}
                          onChange={() => toggleTranslationProvider(provider)}
                        />
                        <span className="model-priority-number">{index + 1}</span>
                        <span className="model-priority-copy">{label}</span>
                        {credentialStatus && credentialStatus.state !== 'valid' ? <button type="button" className={`model-credential-warning status-${credentialStatus.state}`} onClick={() => setSection('keys')}>{credentialStatus.state === 'missing' ? '未新增金鑰' : STATUS_LABELS[credentialStatus.state]}</button> : null}
                      </div>
                    )
                  })}
                </div>
              </div>
            </section>
          ) : null}
          {section === 'storage' ? (
            <StorageSettings compact={windowed} outputRoot={draft.outputRoot} info={storageInfo} loading={storageLoading} action={libraryAction} saving={saving}
              onAction={(action) => void runLibraryAction(action)} onOpen={() => void openStorageLocation()} onRefresh={() => void refreshStorageInfo()} />
          ) : null}
          {section === 'theme' ? <ThemeSettings value={appearance} onChange={changeAppearance} /> : null}
          </div>
          {/* In the window the save bar only appears once there is something to save. */}
          {windowed && !hasUnsavedChanges && !saving ? null : <div className="settings-actions">
            <Typography.Text type={hasUnsavedChanges ? 'warning' : 'secondary'}>{hasUnsavedChanges ? '有未儲存的更改' : '所有更改均已儲存'}</Typography.Text>
            <div className="settings-action-buttons">
              <Button disabled={!hasUnsavedChanges || saving || libraryAction !== null} onClick={discard}>放棄更改</Button>
              <Button type="primary" loading={saving} disabled={!hasUnsavedChanges || libraryAction !== null} onClick={() => void save()}>儲存全部更改</Button>
            </div>
          </div>}
        </div>
      </div>
    </section>
  )
}

function initialCredentials(settings: AppSettings): DraftCredentials {
  return { parser: initialCredentialDraft(settings.credentials.parser) }
}

export function moveProviderBefore(
  order: readonly ActiveTranslationProviderId[],
  source: ActiveTranslationProviderId,
  target: ActiveTranslationProviderId
): ActiveTranslationProviderId[] {
  const sourceIndex = order.indexOf(source)
  const targetIndex = order.indexOf(target)
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return [...order]
  const next = [...order]
  next.splice(sourceIndex, 1)
  next.splice(targetIndex, 0, source)
  return next
}
