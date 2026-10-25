import React from 'react'
import { cachedStorageInfo, loadStorageInfo } from './storageInfoClient'
import { DatabaseOutlined, DeleteOutlined, FileOutlined, FileTextOutlined, FolderOpenOutlined, FolderOutlined, HolderOutlined, ReloadOutlined } from '@ant-design/icons'
import { Button, Checkbox, Input, Typography, message } from 'antd'
import type {
  AppSettings,
  CredentialMutation,
  CredentialName,
  CredentialStatus,
  CredentialValidation,
  SettingsUpdate,
  TranslationProviderId
} from '@shared/types'
import type { StorageInfo, UsageAnalytics } from '@shared/ipcSchemas'
import { formatBytes, StorageComposition, StorageGrowth, StorageMetric, UsageDashboard } from './SettingsDashboards'
import ThemeSettings from './ThemeSettings'
import { previewAppearance, saveAppearance, storedAppearance, type Appearance } from './theme'
import { CodexSettingsCard } from './CodexSettingsCard'
import { ServiceCard } from './ServiceCard'
import PageBrand from './PageBrand'
import type { SettingsNavigationGuard } from './settingsNavigation'

type Section = 'connections' | 'models' | 'storage' | 'theme'

interface DraftCredential {
  value: string
  editing: boolean
  clear: boolean
}

type DraftCredentials = Record<CredentialName, DraftCredential>
type CredentialErrors = Partial<Record<CredentialName, string>>

const CREDENTIAL_LABELS: Record<CredentialName, string> = {
  parser: 'MinerU 解析 Token',
  qwen: 'Qwen API Key',
  deepseek: 'DeepSeek API Key'
}

const STATUS_LABELS: Record<CredentialValidation, string> = {
  missing: '未配置',
  unknown: '待验证',
  valid: '已验证',
  invalid: '验证失败'
}

const MODEL_DETAILS: Record<TranslationProviderId, { label: string; description: string }> = {
  codex: { label: 'Codex', description: '通过本机 Codex 提供大语言模型翻译与论文分析' },
  deepseek: { label: 'DeepSeek', description: '通过 DeepSeek API 提供大语言模型翻译' },
  qwen: { label: '千问 / Qwen', description: '通过阿里云百炼 API 提供专业翻译模型' },
  transmart: { label: 'Transmart', description: '通过腾讯交互翻译网页接口提供机器翻译' },
  bing: { label: 'Bing', description: '通过微软必应翻译网页接口提供机器翻译' }
}

export default function SettingsPage(props: {
  settings: AppSettings
  onSaved(settings: AppSettings): void
  onNavigationGuardChange?(guard: SettingsNavigationGuard | null): void
}): React.JSX.Element {
  const [section, setSection] = React.useState<Section>('connections')
  const [draft, setDraft] = React.useState<AppSettings>(props.settings)
  const [credentials, setCredentials] = React.useState<DraftCredentials>(() => initialCredentials(props.settings))
  const [credentialErrors, setCredentialErrors] = React.useState<CredentialErrors>({})
  const [testing, setTesting] = React.useState<CredentialName | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [storageInfo, setStorageInfo] = React.useState<StorageInfo | null>(() => cachedStorageInfo(props.settings.outputRoot))
  const [usageAnalytics, setUsageAnalytics] = React.useState<UsageAnalytics | null>(null)
  const [storageLoading, setStorageLoading] = React.useState(false)
  const [libraryAction, setLibraryAction] = React.useState<'backup' | 'restore' | 'migrate' | null>(null)
  const libraryActionRef = React.useRef(false)
  const [draggingProvider, setDraggingProvider] = React.useState<TranslationProviderId | null>(null)
  const previousSettingsRef = React.useRef(props.settings)
  const [messageApi, contextHolder] = message.useMessage()

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
      deepseekModel: current.deepseekModel !== previous.deepseekModel ? current.deepseekModel : props.settings.deepseekModel
    }))
    setCredentials((current) => {
      const next = initialCredentials(props.settings)
      // A partial credential save can update the parent settings while another
      // field is still being edited. Keep those local drafts so a failed
      // candidate is not silently replaced by its masked server value.
      for (const name of ['parser', 'qwen', 'deepseek'] as const) {
        if (current[name].editing || current[name].clear) next[name] = current[name]
      }
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

  const runLibraryAction = React.useCallback(async (action: 'backup' | 'restore' | 'migrate') => {
    if (libraryActionRef.current) return
    libraryActionRef.current = true
    setLibraryAction(action)
    try {
      const result = await window.copilotix.manageLibrary({ action })
      if (result.status === 'cancelled') { messageApi.info('文档库操作已取消'); return }
      if (result.restartRequired) {
        messageApi.success('文档库操作完成，应用即将重启')
        return
      }
      messageApi.success('备份完成：' + result.path)
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
    let active = true
    setStorageInfo(cachedStorageInfo(props.settings.outputRoot))
    void loadStorageInfo(props.settings.outputRoot).then(value => { if (active) setStorageInfo(value) }).catch(() => undefined)
    return () => { active = false }
  }, [props.settings.outputRoot])

  React.useEffect(() => {
    if (section !== 'connections') return
    let active = true
    void window.copilotix.getUsageAnalytics()
      .then((analytics) => { if (active) setUsageAnalytics(analytics) })
      .catch(() => { if (active) setUsageAnalytics(null) })
    return () => { active = false }
  }, [section, props.settings])

  const validate = React.useCallback(async (name: CredentialName) => {
    const entry = credentials[name]
    const value = entry.editing ? entry.value.trim() : undefined
    if (entry.editing && !value) {
      setCredentialErrors((current) => ({ ...current, [name]: '请输入凭据后再验证' }))
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
        messageApi.success(`${CREDENTIAL_LABELS[name]}验证成功`)
      } else {
        const error = result.message ?? '凭据验证失败'
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
    const { credentials: _draftCredentials, ...draftSettings } = draft
    const { credentials: _savedCredentials, ...savedSettings } = props.settings
    const publicSettingsChanged = JSON.stringify(draftSettings) !== JSON.stringify(savedSettings)
    const credentialsChanged = (['parser', 'qwen', 'deepseek'] as const).some((name) => {
      const entry = credentials[name]
      return entry.clear || Boolean(entry.value.trim())
    })
    return publicSettingsChanged || credentialsChanged
  }, [credentials, draft, props.settings])

  const save = React.useCallback(async (): Promise<boolean> => {
    if (appearanceChanged) {
      // Local and infallible, so it is kept even if the settings below fail to save.
      saveAppearance(appearance)
      setSavedAppearance(appearance)
      if (!settingsChanged) {
        messageApi.success('设置已保存')
        return true
      }
    }
    setSaving(true)
    try {
      const credentialMutations: Partial<Record<CredentialName, CredentialMutation>> = {}
      for (const name of ['parser', 'qwen', 'deepseek'] as const) {
        const entry = credentials[name]
        if (entry.clear) credentialMutations[name] = { action: 'clear' }
        else if (entry.editing && entry.value.trim()) credentialMutations[name] = { action: 'set', value: entry.value }
      }

      const { credentials: _credentials, ...publicSettings } = draft
      const payload: SettingsUpdate = {
        ...publicSettings,
        ...(Object.keys(credentialMutations).length > 0 ? { credentialMutations } : {})
      }
      const result = await window.copilotix.saveSettings(payload)
      props.onSaved(result.settings)
      setDraft(result.settings)
      if (section === 'storage') void refreshStorageInfo()
      const errors: CredentialErrors = {}
      for (const [name, fieldError] of Object.entries(result.fieldErrors) as Array<[CredentialName, { message: string } | undefined]>) {
        if (fieldError) errors[name] = fieldError.message
      }
      setCredentialErrors(errors)
      setCredentials((current) => {
        const next = { ...current }
        for (const name of ['parser', 'qwen', 'deepseek'] as const) {
          if (errors[name]) continue
          if (current[name].editing || current[name].clear) next[name] = { value: '', editing: false, clear: false }
        }
        return next
      })
      if (Object.keys(errors).length > 0) messageApi.warning('普通设置及有效凭据已保存，请修正失败字段')
      else messageApi.success('设置已保存')
      return Object.keys(errors).length === 0
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      setSaving(false)
    }
  }, [appearance, appearanceChanged, credentials, draft, messageApi, props.onSaved, refreshStorageInfo, section, settingsChanged])

  const moveProvider = React.useCallback((source: TranslationProviderId, target: TranslationProviderId) => {
    setDraft((current) => {
      const order = moveProviderBefore(current.translationProviderOrder, source, target)
      return {
        ...current,
        translationProvider: order.find((provider) => current.enabledTranslationProviders.includes(provider))!,
        translationProviderOrder: order
      }
    })
  }, [])

  const finishProviderDrag = React.useCallback(() => {
    if (!draggingProvider) return
    setDraggingProvider(null)
  }, [draggingProvider])

  const toggleTranslationProvider = React.useCallback((provider: TranslationProviderId) => {
    const enabled = draft.enabledTranslationProviders.includes(provider)
    if (enabled && draft.enabledTranslationProviders.length === 1) {
      messageApi.warning('至少需要启用一个翻译模型')
      return
    }
    setDraft((current) => {
      const next = enabled
        ? current.enabledTranslationProviders.filter((candidate) => candidate !== provider)
        : [...current.enabledTranslationProviders, provider]
      return {
        ...current,
        translationProvider: current.translationProviderOrder.find((candidate) => next.includes(candidate))!,
        enabledTranslationProviders: next
      }
    })
  }, [draft.enabledTranslationProviders, messageApi])

  const moveProviderByKeyboard = React.useCallback((provider: TranslationProviderId, direction: -1 | 1) => {
    const index = draft.translationProviderOrder.indexOf(provider)
    const targetIndex = index + direction
    if (index < 0 || targetIndex < 0 || targetIndex >= draft.translationProviderOrder.length) return
    const next = [...draft.translationProviderOrder]
    ;[next[index], next[targetIndex]] = [next[targetIndex]!, next[index]!]
    setDraft((current) => ({
      ...current,
      translationProvider: next.find((candidate) => current.enabledTranslationProviders.includes(candidate))!,
      translationProviderOrder: next
    }))
  }, [draft.translationProviderOrder])

  const hasUnsavedChanges = settingsChanged || appearanceChanged

  const discard = React.useCallback(() => {
    setDraft(props.settings)
    setCredentials(initialCredentials(props.settings))
    setCredentialErrors({})
    setAppearance(savedAppearance)
    previewAppearance(savedAppearance)
  }, [props.settings, savedAppearance])

  const onNavigationGuardChange = props.onNavigationGuardChange
  React.useLayoutEffect(() => {
    onNavigationGuardChange?.({ dirty: hasUnsavedChanges, busy: saving || testing !== null || libraryAction !== null, save, discard })
  }, [onNavigationGuardChange, hasUnsavedChanges, saving, testing, libraryAction, save, discard])
  React.useLayoutEffect(() => () => onNavigationGuardChange?.(null), [onNavigationGuardChange])

  return (
    <section className="page settings-page">
      {contextHolder}
      <PageBrand eyebrow="COPILOTIX / SETTINGS" title="设置" />
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置分类">
          <button className={section === 'connections' ? 'active' : ''} onClick={() => setSection('connections')}><small aria-hidden="true">01</small>服务连接</button>
          <button className={section === 'models' ? 'active' : ''} onClick={() => setSection('models')}><small aria-hidden="true">02</small>模型设置</button>
          <button className={section === 'storage' ? 'active' : ''} onClick={() => setSection('storage')}><small aria-hidden="true">03</small>文件存储</button>
          <button className={section === 'theme' ? 'active' : ''} onClick={() => setSection('theme')}><small aria-hidden="true">04</small>显示设置</button>
        </nav>
        <div className="settings-content">
          <div className="settings-content-body">
          {section === 'connections' ? (
            <section className="settings-section service-connections" aria-label="服务连接">
              <ServiceCard
                title="MinerU"
                badge="必需"
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
                title="DeepSeek"
                badge="可选"
                name="deepseek"
                state={draft.credentials.deepseek.state}
                stateLabel={draft.credentials.deepseek.message ?? STATUS_LABELS[draft.credentials.deepseek.state]}
              >
                <CredentialEditor
                  name="deepseek"
                  status={draft.credentials.deepseek}
                  draft={credentials.deepseek}
                  error={credentialErrors.deepseek}
                  testing={testing === 'deepseek'}
                  onDraft={(patch) => updateCredentialDraft('deepseek', patch)}
                  onValidate={() => void validate('deepseek')}
                />
              </ServiceCard>
              <ServiceCard
                title="Qwen"
                badge="可选"
                name="qwen"
                state={draft.credentials.qwen.state}
                stateLabel={draft.credentials.qwen.message ?? STATUS_LABELS[draft.credentials.qwen.state]}
              >
                <CredentialEditor
                  name="qwen"
                  status={draft.credentials.qwen}
                  draft={credentials.qwen}
                  error={credentialErrors.qwen}
                  testing={testing === 'qwen'}
                  onDraft={(patch) => updateCredentialDraft('qwen', patch)}
                  onValidate={() => void validate('qwen')}
                />
              </ServiceCard>
              <CodexSettingsCard value={draft.codex} onChange={codex => setDraft(current => ({ ...current, codex }))} />
              <UsageDashboard analytics={usageAnalytics} />
            </section>
          ) : null}
          {section === 'models' ? (
            <section className="settings-section model-priority" aria-label="模型设置">
              <div className="model-priority-card">
                <div className="model-priority-heading"><strong>大语言模型优先级</strong><span className="model-request-order"><span>请求顺序</span><strong>{draft.translationProviderOrder.filter((provider) => draft.enabledTranslationProviders.includes(provider)).map((provider) => MODEL_DETAILS[provider].label.replace(' / Qwen', '')).join(' → ')}</strong></span></div>
                <div className="model-priority-list" role="list" aria-label="翻译模型优先级">
                  {draft.translationProviderOrder.map((provider, index) => {
                    const details = MODEL_DETAILS[provider]
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
                          aria-label={`移动${details.label}`}
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
                          aria-label={`启用${details.label}`}
                          checked={draft.enabledTranslationProviders.includes(provider)}
                          disabled={saving}
                          onChange={() => toggleTranslationProvider(provider)}
                        />
                        <span className="model-priority-number">{String(index + 1).padStart(2, '0')}</span>
                        <span className="model-priority-copy"><strong>{details.label}</strong><small>{details.description}</small></span>
                        {credentialStatus && credentialStatus.state !== 'valid' ? <span className={`model-credential-warning status-${credentialStatus.state}`}>{credentialStatus.state === 'missing' ? '未填写密钥' : STATUS_LABELS[credentialStatus.state]}</span> : null}
                      </div>
                    )
                  })}
                </div>
              </div>
            </section>
          ) : null}
          {section === 'storage' ? (
            <section className="settings-section storage-management" aria-label="文件存储">
              <div className="storage-location-card">
                <div className="storage-card-heading">
                  <span className="storage-card-icon"><FolderOutlined /></span>
                  <span><strong>文档保存位置</strong><small>新建解析任务及其翻译结果会保存到此目录</small></span>
                </div>
                <label className="storage-location-field">
                  <span>目录位置</span>
                  <Input aria-label="文档保存位置" readOnly value={draft.outputRoot} />
                </label>
                <div className="storage-location-actions" aria-busy={libraryAction !== null}>
                  <Button loading={libraryAction === 'backup'} disabled={libraryAction !== null || saving || storageLoading} onClick={() => void runLibraryAction('backup')}>导出文库</Button>
                  <Button loading={libraryAction === 'restore'} disabled={libraryAction !== null || saving || storageLoading} onClick={() => void runLibraryAction('restore')}>导入文库</Button>
                  <Button loading={libraryAction === 'migrate'} disabled={libraryAction !== null || saving || storageLoading} onClick={() => void runLibraryAction('migrate')}>迁移文库</Button>
                  <Button disabled={libraryAction !== null} icon={<FolderOpenOutlined aria-hidden="true" />} onClick={() => void openStorageLocation()}>打开当前目录</Button>
                </div>
              </div>
              <div className="storage-usage-card" aria-busy={storageLoading}>
                <div className="storage-usage-heading">
                  <span><strong>存储用量</strong><small>{storageInfo?.exists === false ? '文档目录尚未建立' : '当前已保存内容'}</small></span>
                  <Button disabled={libraryAction !== null} icon={<ReloadOutlined />} loading={storageLoading} onClick={() => void refreshStorageInfo()}>刷新用量</Button>
                </div>
                <div className="storage-usage-grid">
                  <StorageMetric icon={<FileTextOutlined />} label="文档" value={storageInfo ? String(storageInfo.documentCount) : '—'} />
                  <StorageMetric icon={<FileOutlined />} label="文件" value={storageInfo ? String(storageInfo.fileCount) : '—'} />
                  <StorageMetric icon={<DatabaseOutlined />} label="占用空间" value={storageInfo ? formatBytes(storageInfo.totalBytes) : '—'} />
                </div>
              </div>
              <div className="storage-insights">
                <StorageComposition info={storageInfo} />
                <StorageGrowth info={storageInfo} />
              </div>
              <Typography.Text className="storage-note" type="secondary">导出文库包含文档、标注和设置，不包含 API 密钥；导入或迁移会保留旧库并在完成后重启。</Typography.Text>
            </section>
          ) : null}
          {section === 'theme' ? <ThemeSettings value={appearance} onChange={changeAppearance} /> : null}
          </div>
          <div className="settings-actions">
            <Typography.Text type={hasUnsavedChanges ? 'warning' : 'secondary'}>{hasUnsavedChanges ? '有未保存的更改' : '所有更改均已保存'}</Typography.Text>
            <div className="settings-action-buttons">
              <Button size="large" disabled={!hasUnsavedChanges || saving || libraryAction !== null} onClick={discard}>放弃更改</Button>
              <Button type="primary" size="large" loading={saving} disabled={!hasUnsavedChanges || libraryAction !== null} onClick={() => void save()}>保存全部更改</Button>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function initialCredentials(settings: AppSettings): DraftCredentials {
  return {
    parser: initialCredentialDraft(settings.credentials.parser),
    qwen: initialCredentialDraft(settings.credentials.qwen),
    deepseek: initialCredentialDraft(settings.credentials.deepseek)
  }
}

function initialCredentialDraft(status: CredentialStatus): DraftCredential {
  return { value: '', editing: status.state === 'missing', clear: false }
}

function CredentialEditor(props: {
  name: CredentialName
  status: CredentialStatus
  draft: DraftCredential
  error?: string
  testing: boolean
  onDraft(patch: Partial<DraftCredential>): void
  onValidate(): void
}): React.JSX.Element {
  const configured = props.status.state !== 'missing'
  const editing = props.draft.editing
  const distinctError = props.error && props.error !== props.status.message ? props.error : undefined
  return (
    <div className="credential-editor">
      <label className="credential-label" htmlFor={`credential-${props.name}`}>APIKey</label>
      <div className={`credential-control${configured && !editing && !props.draft.clear ? ' credential-control-masked' : ''}`}>
        {editing ? (
          <Input.Password
            id={`credential-${props.name}`}
            autoComplete="new-password"
            value={props.draft.value}
            onChange={(event) => props.onDraft({ value: event.target.value, clear: false })}
            placeholder="输入新密钥"
            visibilityToggle={false}
          />
        ) : (
          <Input
            id={`credential-${props.name}`}
            aria-label="APIKey"
            value=""
            readOnly
            placeholder={configured ? undefined : '输入新密钥'}
            onFocus={() => props.onDraft({ editing: true, value: '', clear: false })}
          />
        )}
      </div>
      <div className="credential-actions">
        <Button
          danger
          icon={<DeleteOutlined />}
          disabled={!configured && !props.draft.value && !props.draft.clear}
          onClick={() => props.onDraft({ editing: true, value: '', clear: true })}
        >删除</Button>
        <Button className="credential-validate" loading={props.testing} disabled={props.draft.clear || (editing && !props.draft.value.trim())} onClick={props.onValidate}>测试连接</Button>
      </div>
      <div className="credential-meta">
        {distinctError ? <Typography.Text type="danger">{distinctError}</Typography.Text> : null}
      </div>
    </div>
  )
}

export function moveProviderBefore(
  order: readonly TranslationProviderId[],
  source: TranslationProviderId,
  target: TranslationProviderId
): TranslationProviderId[] {
  const sourceIndex = order.indexOf(source)
  const targetIndex = order.indexOf(target)
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return [...order]
  const next = [...order]
  next.splice(sourceIndex, 1)
  next.splice(targetIndex, 0, source)
  return next
}
