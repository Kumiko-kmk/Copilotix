import React from 'react'
import { CheckCircleOutlined, CloseCircleOutlined, DeleteOutlined, FolderOpenOutlined, FolderOutlined, HolderOutlined, LinkOutlined, ReloadOutlined, SettingOutlined } from '@ant-design/icons'
import { Button, Checkbox, Input, Space, Typography, message } from 'antd'
import type {
  AppSettings,
  CredentialMutation,
  CredentialName,
  CredentialStatus,
  CredentialValidation,
  SettingsUpdate,
  TranslationProviderId
} from '@shared/types'
import type { StorageInfo, UsageAnalytics, UsageAnalyticsDay } from '@shared/ipcSchemas'

type Section = 'connections' | 'models' | 'storage'

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
  deepseek: { label: 'DeepSeek', description: '通过 DeepSeek API 提供大语言模型翻译' },
  qwen: { label: '千问 / Qwen', description: '通过阿里云百炼 API 提供专业翻译模型' },
  transmart: { label: 'Transmart', description: '通过腾讯交互翻译网页接口提供机器翻译' },
  bing: { label: 'Bing', description: '通过微软必应翻译网页接口提供机器翻译' }
}

export default function SettingsPage(props: {
  settings: AppSettings
  onSaved(settings: AppSettings): void
}): React.JSX.Element {
  const [section, setSection] = React.useState<Section>('connections')
  const [draft, setDraft] = React.useState<AppSettings>(props.settings)
  const [credentials, setCredentials] = React.useState<DraftCredentials>(() => initialCredentials(props.settings))
  const [credentialErrors, setCredentialErrors] = React.useState<CredentialErrors>({})
  const [testing, setTesting] = React.useState<CredentialName | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [policySaving, setPolicySaving] = React.useState(false)
  const [storageInfo, setStorageInfo] = React.useState<StorageInfo | null>(null)
  const [usageAnalytics, setUsageAnalytics] = React.useState<UsageAnalytics | null>(null)
  const [storageLoading, setStorageLoading] = React.useState(false)
  const [draggingProvider, setDraggingProvider] = React.useState<TranslationProviderId | null>(null)
  const dragBaselineRef = React.useRef<TranslationProviderId[] | null>(null)
  const providerOrderRef = React.useRef<TranslationProviderId[]>(props.settings.translationProviderOrder)
  const previousSettingsRef = React.useRef(props.settings)
  const [messageApi, contextHolder] = message.useMessage()

  React.useEffect(() => {
    const previous = previousSettingsRef.current
    setDraft((current) => ({
      ...props.settings,
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

  React.useEffect(() => {
    providerOrderRef.current = draft.translationProviderOrder
  }, [draft.translationProviderOrder])

  const update = React.useCallback(<K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setDraft((current) => ({ ...current, [key]: value }))
  }, [])

  const updateCredentialDraft = React.useCallback((name: CredentialName, patch: Partial<DraftCredential>) => {
    setCredentialErrors((current) => ({ ...current, [name]: undefined }))
    setCredentials((current) => ({ ...current, [name]: { ...current[name], ...patch } }))
  }, [])

  const chooseOutput = React.useCallback(async () => {
    const path = await window.copilotix.chooseOutputDirectory()
    if (path) update('outputRoot', path)
  }, [update])

  const refreshStorageInfo = React.useCallback(async () => {
    setStorageLoading(true)
    try {
      setStorageInfo(await window.copilotix.getStorageInfo())
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : String(error))
    } finally {
      setStorageLoading(false)
    }
  }, [messageApi])

  const openStorageLocation = React.useCallback(async () => {
    try {
      await window.copilotix.openStorageLocation()
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : String(error))
    }
  }, [messageApi])

  React.useEffect(() => {
    if (section === 'storage') void refreshStorageInfo()
  }, [props.settings.outputRoot, refreshStorageInfo, section])

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

  const save = React.useCallback(async () => {
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
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }, [credentials, draft, messageApi, props.onSaved, refreshStorageInfo, section])

  const persistProviderPolicy = React.useCallback(async (
    order: TranslationProviderId[],
    enabledCandidates: TranslationProviderId[]
  ) => {
    const enabled = order.filter((provider) => enabledCandidates.includes(provider))
    if (enabled.length === 0) return
    const previousOrder = props.settings.translationProviderOrder
    const previousEnabled = props.settings.enabledTranslationProviders
    setDraft((current) => ({
      ...current,
      translationProvider: enabled[0]!,
      translationProviderOrder: order,
      enabledTranslationProviders: enabled
    }))
    providerOrderRef.current = order
    setPolicySaving(true)
    try {
      const { credentials: _credentials, ...savedPublicSettings } = props.settings
      const result = await window.copilotix.saveSettings({
        ...savedPublicSettings,
        translationProvider: enabled[0]!,
        translationProviderOrder: order,
        enabledTranslationProviders: enabled
      })
      props.onSaved(result.settings)
    } catch (error) {
      providerOrderRef.current = previousOrder
      setDraft((current) => ({
        ...current,
        translationProvider: previousOrder.find((provider) => previousEnabled.includes(provider))!,
        translationProviderOrder: previousOrder,
        enabledTranslationProviders: previousEnabled
      }))
      messageApi.error(error instanceof Error ? error.message : String(error))
    } finally {
      setPolicySaving(false)
    }
  }, [messageApi, props.onSaved, props.settings])

  const moveProvider = React.useCallback((source: TranslationProviderId, target: TranslationProviderId) => {
    setDraft((current) => {
      const order = moveProviderBefore(current.translationProviderOrder, source, target)
      providerOrderRef.current = order
      return { ...current, translationProviderOrder: order }
    })
  }, [])

  const finishProviderDrag = React.useCallback(() => {
    if (!draggingProvider) return
    const finalOrder = providerOrderRef.current
    const changed = dragBaselineRef.current?.some((provider, index) => finalOrder[index] !== provider) ?? false
    setDraggingProvider(null)
    dragBaselineRef.current = null
    if (changed) void persistProviderPolicy(finalOrder, draft.enabledTranslationProviders)
  }, [draft.enabledTranslationProviders, draggingProvider, persistProviderPolicy])

  const toggleTranslationProvider = React.useCallback((provider: TranslationProviderId) => {
    const enabled = draft.enabledTranslationProviders.includes(provider)
    if (enabled && draft.enabledTranslationProviders.length === 1) {
      messageApi.warning('至少需要启用一个翻译模型')
      return
    }
    const next = enabled
      ? draft.enabledTranslationProviders.filter((candidate) => candidate !== provider)
      : [...draft.enabledTranslationProviders, provider]
    void persistProviderPolicy(draft.translationProviderOrder, next)
  }, [draft.enabledTranslationProviders, draft.translationProviderOrder, messageApi, persistProviderPolicy])

  const moveProviderByKeyboard = React.useCallback((provider: TranslationProviderId, direction: -1 | 1) => {
    const index = draft.translationProviderOrder.indexOf(provider)
    const targetIndex = index + direction
    if (index < 0 || targetIndex < 0 || targetIndex >= draft.translationProviderOrder.length) return
    const next = [...draft.translationProviderOrder]
    ;[next[index], next[targetIndex]] = [next[targetIndex]!, next[index]!]
    void persistProviderPolicy(next, draft.enabledTranslationProviders)
  }, [draft.enabledTranslationProviders, draft.translationProviderOrder, persistProviderPolicy])

  const hasUnsavedChanges = React.useMemo(() => {
    const { credentials: _draftCredentials, translationProvider: _draftProvider, translationProviderOrder: _draftOrder, enabledTranslationProviders: _draftEnabled, ...draftSettings } = draft
    const { credentials: _savedCredentials, translationProvider: _savedProvider, translationProviderOrder: _savedOrder, enabledTranslationProviders: _savedEnabled, ...savedSettings } = props.settings
    const publicSettingsChanged = JSON.stringify(draftSettings) !== JSON.stringify(savedSettings)
    const credentialsChanged = (['parser', 'qwen', 'deepseek'] as const).some((name) => {
      const entry = credentials[name]
      return entry.clear || Boolean(entry.value.trim())
    })
    return publicSettingsChanged || credentialsChanged
  }, [credentials, draft, props.settings])

  const discard = React.useCallback(() => {
    setDraft(props.settings)
    setCredentials(initialCredentials(props.settings))
    setCredentialErrors({})
  }, [props.settings])

  return (
    <section className="page settings-page">
      {contextHolder}
      <header className="page-header"><Typography.Title level={2}>设置</Typography.Title></header>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置分类">
          <button className={section === 'connections' ? 'active' : ''} onClick={() => setSection('connections')}><LinkOutlined />服务连接</button>
          <button className={section === 'models' ? 'active' : ''} onClick={() => setSection('models')}><SettingOutlined />模型设置</button>
          <button className={section === 'storage' ? 'active' : ''} onClick={() => setSection('storage')}><FolderOutlined />文件存储</button>
        </nav>
        <div className="settings-content">
          <div className="settings-content-body">
          {section === 'connections' ? (
            <section className="settings-section service-connections" aria-label="服务连接">
              <ServiceCard
                title="MinerU"
                badge="必需"
                name="parser"
                status={draft.credentials.parser}
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
                status={draft.credentials.deepseek}
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
                status={draft.credentials.qwen}
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
              <UsageDashboard analytics={usageAnalytics} />
            </section>
          ) : null}
          {section === 'models' ? (
            <section className="settings-section model-priority" aria-label="模型设置">
              <div className="model-priority-card">
                <div className="model-priority-heading">大语言模型优先级</div>
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
                          draggable={!policySaving}
                          disabled={policySaving}
                          onDragStart={(event) => {
                            event.dataTransfer.effectAllowed = 'move'
                            dragBaselineRef.current = [...draft.translationProviderOrder]
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
                          disabled={policySaving}
                          onChange={() => toggleTranslationProvider(provider)}
                        />
                        <span className="model-priority-number">{String(index + 1).padStart(2, '0')}</span>
                        <span className="model-priority-copy"><strong>{details.label}</strong><small>{details.description}</small></span>
                        {credentialStatus && credentialStatus.state !== 'valid' ? <span className={`model-credential-warning status-${credentialStatus.state}`}>{credentialStatus.state === 'missing' ? '未填写密钥' : STATUS_LABELS[credentialStatus.state]}</span> : null}
                      </div>
                    )
                  })}
                </div>
                <div className="model-request-order"><span>请求顺序</span><strong>{draft.translationProviderOrder.filter((provider) => draft.enabledTranslationProviders.includes(provider)).map((provider) => MODEL_DETAILS[provider].label.replace(' / Qwen', '')).join(' → ')}</strong></div>
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
                  <Space.Compact block>
                    <Input aria-label="文档保存位置" readOnly value={draft.outputRoot} />
                    <Button icon={<FolderOpenOutlined />} onClick={() => void chooseOutput()}>修改位置</Button>
                  </Space.Compact>
                </label>
                {draft.outputRoot !== props.settings.outputRoot ? <Typography.Text type="warning">新位置将在保存全部更改后生效</Typography.Text> : null}
                <div className="storage-location-actions">
                  <Button onClick={() => void openStorageLocation()}>打开当前目录</Button>
                  <Button icon={<ReloadOutlined />} loading={storageLoading} onClick={() => void refreshStorageInfo()}>刷新用量</Button>
                </div>
              </div>

              <div className="storage-usage-card" aria-busy={storageLoading}>
                <div className="storage-usage-heading"><strong>存储用量</strong><span>{storageInfo?.exists === false ? '文档目录尚未建立' : '当前已保存内容'}</span></div>
                <div className="storage-usage-grid">
                  <StorageMetric label="文档" value={storageInfo ? String(storageInfo.documentCount) : '—'} />
                  <StorageMetric label="文件" value={storageInfo ? String(storageInfo.fileCount) : '—'} />
                  <StorageMetric label="占用空间" value={storageInfo ? formatBytes(storageInfo.totalBytes) : '—'} />
                </div>
              </div>
              <Typography.Text className="storage-note" type="secondary">修改位置不会移动既有文档；既有任务仍保留原位置，新任务使用保存后的目录。</Typography.Text>
            </section>
          ) : null}
          </div>
          {section !== 'models' ? <div className="settings-actions">
            <Typography.Text type={hasUnsavedChanges ? 'warning' : 'secondary'}>{hasUnsavedChanges ? '有未保存的更改' : '所有更改均已保存'}</Typography.Text>
            <div className="settings-action-buttons">
              <Button size="large" disabled={!hasUnsavedChanges || saving} onClick={discard}>放弃更改</Button>
              <Button type="primary" size="large" loading={saving} disabled={!hasUnsavedChanges} onClick={() => void save()}>保存全部更改</Button>
            </div>
          </div> : null}
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

function StatusIndicator(props: { status: CredentialStatus }): React.JSX.Element {
  const icon = props.status.state === 'valid' ? <CheckCircleOutlined /> : props.status.state === 'invalid' ? <CloseCircleOutlined /> : null
  return <span className={`credential-status status-${props.status.state}`}>{icon}<span>{props.status.message ?? STATUS_LABELS[props.status.state]}</span></span>
}

function ServiceCard(props: {
  title: string
  badge: string
  name: CredentialName
  status: CredentialStatus
  children: React.ReactNode
}): React.JSX.Element {
  const header = <>
    <span className="service-card-identity"><strong>{props.title}</strong><span className="service-card-badge">{props.badge}</span></span>
    <span className="service-card-summary"><StatusIndicator status={props.status} /></span>
  </>
  return (
    <section className="service-card expanded" data-provider={props.name}>
      <div className="service-card-header">{header}</div>
      <div className="service-card-body">{props.children}</div>
    </section>
  )
}

function UsageDashboard(props: { analytics: UsageAnalytics | null }): React.JSX.Element {
  const days = props.analytics?.days ?? emptyAnalyticsDays(84)
  return (
    <section className="usage-dashboard" aria-label="APIKey 用量分析">
      <ActivityHeatmap days={days} />
      <TokenTrendChart days={days.slice(-30)} />
    </section>
  )
}

function ActivityHeatmap(props: { days: UsageAnalyticsDay[] }): React.JSX.Element {
  const scores = props.days.map((day) => day.documents * 8 + day.pages)
  const maximum = Math.max(1, ...scores)
  const totalDocuments = props.days.reduce((sum, day) => sum + day.documents, 0)
  const totalPages = props.days.reduce((sum, day) => sum + day.pages, 0)
  return (
    <article className="usage-panel activity-panel">
      <header className="usage-panel-header">
        <span><strong>活动热力</strong><small>最近 12 周</small></span>
        <span className="usage-panel-total">共计 {totalPages} 页</span>
      </header>
      <div className="activity-heatmap" role="img" aria-label={`最近十二週上傳 ${totalDocuments} 份文檔，共 ${totalPages} 頁`}>
        {props.days.map((day, index) => {
          const score = scores[index] ?? 0
          const level = score === 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((score / maximum) * 4)))
          return <span key={day.date} className={`activity-cell level-${level}`} title={`${day.date}：${day.documents} 份文檔，${day.pages} 頁`} />
        })}
      </div>
      <footer className="activity-legend"><span>少</span>{[0, 1, 2, 3, 4].map((level) => <i key={level} className={`activity-cell level-${level}`} />)}<span>多</span></footer>
    </article>
  )
}

function TokenTrendChart(props: { days: UsageAnalyticsDay[] }): React.JSX.Element {
  const width = 480
  const height = 150
  const insetX = 18
  const insetTop = 16
  const insetBottom = 24
  const values = props.days.flatMap((day) => [day.deepseekTokens, day.qwenTokens])
  const maximum = Math.max(1, ...values)
  const points = (key: 'deepseekTokens' | 'qwenTokens'): string => props.days.map((day, index) => {
    const x = insetX + (index / Math.max(1, props.days.length - 1)) * (width - insetX * 2)
    const y = insetTop + (1 - day[key] / maximum) * (height - insetTop - insetBottom)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  const deepseekTotal = props.days.reduce((sum, day) => sum + day.deepseekTokens, 0)
  const qwenTotal = props.days.reduce((sum, day) => sum + day.qwenTokens, 0)
  return (
    <article className="usage-panel token-panel">
      <header className="usage-panel-header">
        <span><strong>模型 Token</strong><small>最近 30 天</small></span>
        <span className="token-legend"><i className="deepseek" />DeepSeek {compactNumber(deepseekTotal)}<i className="qwen" />Qwen {compactNumber(qwenTotal)}</span>
      </header>
      <svg className="token-trend-chart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`DeepSeek ${deepseekTotal} Token，Qwen ${qwenTotal} Token`}>
        {[0, 0.5, 1].map((ratio) => <line key={ratio} x1={insetX} x2={width - insetX} y1={insetTop + ratio * (height - insetTop - insetBottom)} y2={insetTop + ratio * (height - insetTop - insetBottom)} className="token-grid-line" />)}
        <polyline points={points('deepseekTokens')} className="token-line deepseek" />
        <polyline points={points('qwenTokens')} className="token-line qwen" />
      </svg>
    </article>
  )
}

function emptyAnalyticsDays(count: number): UsageAnalyticsDay[] {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  date.setDate(date.getDate() - count + 1)
  return Array.from({ length: count }, () => {
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    date.setDate(date.getDate() + 1)
    return { date: key, documents: 0, pages: 0, deepseekTokens: 0, qwenTokens: 0 }
  })
}

function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`
  return String(value)
}

function StorageMetric(props: { label: string; value: string }): React.JSX.Element {
  return <div className="storage-metric"><span>{props.label}</span><strong>{props.value}</strong></div>
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[unit]}`
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
