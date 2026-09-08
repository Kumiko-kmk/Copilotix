import React from 'react'
import { ApiOutlined, CheckCircleOutlined, CloseCircleOutlined, DeleteOutlined, EditOutlined, FolderOpenOutlined, SettingOutlined } from '@ant-design/icons'
import { Alert, Button, Collapse, Input, Select, Space, Switch, Tag, Typography, message } from 'antd'
import { PROVIDER_LABELS } from '@shared/constants'
import type {
  AppSettings,
  CredentialMutation,
  CredentialName,
  CredentialStatus,
  CredentialValidation,
  SettingsUpdate,
  TranslationProviderId
} from '@shared/types'

type Section = 'system' | 'parameters'

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

export default function SettingsPage(props: {
  settings: AppSettings
  onSaved(settings: AppSettings): void
}): React.JSX.Element {
  const [section, setSection] = React.useState<Section>('system')
  const [draft, setDraft] = React.useState<AppSettings>(props.settings)
  const [credentials, setCredentials] = React.useState<DraftCredentials>(() => initialCredentials(props.settings))
  const [credentialErrors, setCredentialErrors] = React.useState<CredentialErrors>({})
  const [testing, setTesting] = React.useState<CredentialName | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [messageApi, contextHolder] = message.useMessage()

  React.useEffect(() => {
    setDraft(props.settings)
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
  }, [props.settings])

  const update = React.useCallback(<K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setDraft((current) => ({ ...current, [key]: value }))
  }, [])

  const updateCredentialDraft = React.useCallback((name: CredentialName, patch: Partial<DraftCredential>) => {
    setCredentialErrors((current) => ({ ...current, [name]: undefined }))
    setCredentials((current) => ({ ...current, [name]: { ...current[name], ...patch } }))
  }, [])

  const chooseOutput = React.useCallback(async () => {
    const path = await window.mineru.chooseOutputDirectory()
    if (path) update('outputRoot', path)
  }, [update])

  const validate = React.useCallback(async (name: CredentialName) => {
    const entry = credentials[name]
    const value = entry.editing ? entry.value.trim() : undefined
    if (entry.editing && !value) {
      setCredentialErrors((current) => ({ ...current, [name]: '请输入凭据后再验证' }))
      return
    }
    setTesting(name)
    try {
      const result = await window.mineru.validateCredential(name, value)
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
      const localErrors: CredentialErrors = {}
      for (const name of ['parser', 'qwen', 'deepseek'] as const) {
        const entry = credentials[name]
        if (entry.clear) credentialMutations[name] = { action: 'clear' }
        else if (entry.editing) {
          if (!entry.value.trim()) localErrors[name] = '请输入凭据，或使用“清除”删除已保存值'
          else credentialMutations[name] = { action: 'set', value: entry.value }
        }
      }
      if (Object.keys(localErrors).length > 0) {
        setCredentialErrors(localErrors)
        messageApi.error('请先修正凭据输入')
        return
      }

      const { credentials: _credentials, ...publicSettings } = draft
      const payload: SettingsUpdate = {
        ...publicSettings,
        ...(Object.keys(credentialMutations).length > 0 ? { credentialMutations } : {})
      }
      const result = await window.mineru.saveSettings(payload)
      props.onSaved(result.settings)
      setDraft(result.settings)
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
  }, [credentials, draft, messageApi, props.onSaved])

  return (
    <section className="page settings-page">
      {contextHolder}
      <header className="page-header"><Typography.Title level={2}>设置</Typography.Title></header>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置分类">
          <button className={section === 'system' ? 'active' : ''} onClick={() => setSection('system')}><SettingOutlined />系统设置</button>
          <button className={section === 'parameters' ? 'active' : ''} onClick={() => setSection('parameters')}><ApiOutlined />参数设置</button>
        </nav>
        <div className="settings-content">
          {section === 'system' ? (
            <>
              <Typography.Title level={4}>解析 API</Typography.Title>
              <SettingField label="服务地址"><Input value="https://mineru.net" readOnly /></SettingField>
              <CredentialEditor
                name="parser"
                status={draft.credentials.parser}
                draft={credentials.parser}
                error={credentialErrors.parser}
                testing={testing === 'parser'}
                onDraft={(patch) => updateCredentialDraft('parser', patch)}
                onValidate={() => void validate('parser')}
              />
              <Typography.Title level={4} className="settings-subtitle">结果保存</Typography.Title>
              <SettingField label="解析结果保存至">
                <Space.Compact block><Input readOnly value={draft.outputRoot} /><Button icon={<FolderOpenOutlined />} onClick={() => void chooseOutput()}>更换</Button></Space.Compact>
              </SettingField>
            </>
          ) : (
            <>
              <Typography.Title level={4}>解析参数</Typography.Title>
              <ToggleField label="开启公式识别" checked={draft.formulaEnabled} onChange={(value) => update('formulaEnabled', value)} />
              <ToggleField label="开启表格识别" checked={draft.tableEnabled} onChange={(value) => update('tableEnabled', value)} />

              <Typography.Title level={4} className="settings-subtitle">自动翻译</Typography.Title>
              <SettingField label="默认翻译模型">
                <Select<TranslationProviderId> value={draft.translationProvider} onChange={(value) => update('translationProvider', value)} options={Object.entries(PROVIDER_LABELS).map(([value, label]) => ({ value: value as TranslationProviderId, label }))} />
              </SettingField>
              <ProviderPanel title="千问">
                <CredentialEditor
                  name="qwen"
                  status={draft.credentials.qwen}
                  draft={credentials.qwen}
                  error={credentialErrors.qwen}
                  testing={testing === 'qwen'}
                  onDraft={(patch) => updateCredentialDraft('qwen', patch)}
                  onValidate={() => void validate('qwen')}
                />
                <AdvancedModel baseUrl={draft.qwenBaseUrl} model={draft.qwenModel} onBaseUrl={(value) => update('qwenBaseUrl', value)} onModel={(value) => update('qwenModel', value)} />
              </ProviderPanel>
              <ProviderPanel title="DeepSeek">
                <CredentialEditor
                  name="deepseek"
                  status={draft.credentials.deepseek}
                  draft={credentials.deepseek}
                  error={credentialErrors.deepseek}
                  testing={testing === 'deepseek'}
                  onDraft={(patch) => updateCredentialDraft('deepseek', patch)}
                  onValidate={() => void validate('deepseek')}
                />
                <AdvancedModel baseUrl={draft.deepseekBaseUrl} model={draft.deepseekModel} onBaseUrl={(value) => update('deepseekBaseUrl', value)} onModel={(value) => update('deepseekModel', value)} />
              </ProviderPanel>
              <Alert type="warning" showIcon message="Bing 与腾讯 TranSmart 使用非官方网页接口" description="接口可能限流或随时失效；客户端会自动重试并切换其他已配置翻译源。" />
            </>
          )}
          <div className="settings-actions"><Button type="primary" size="large" loading={saving} onClick={() => void save()}>保存设置</Button></div>
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
  const replacing = props.draft.editing
  return (
    <div className="credential-editor">
      <SettingField label={CREDENTIAL_LABELS[props.name]}>
        {replacing ? (
          <Input.Password
            autoComplete="new-password"
            value={props.draft.value}
            onChange={(event) => props.onDraft({ value: event.target.value, clear: false })}
            placeholder="输入新凭据"
          />
        ) : (
          <Input value={props.status.maskedValue ?? ''} readOnly placeholder="尚未配置" />
        )}
      </SettingField>
      <Space wrap>
        <Tag color={statusColor(props.status.state)} icon={props.status.state === 'valid' ? <CheckCircleOutlined /> : props.status.state === 'invalid' ? <CloseCircleOutlined /> : undefined}>
          {STATUS_LABELS[props.status.state]}
        </Tag>
        {!replacing ? <Button size="small" icon={<EditOutlined />} onClick={() => props.onDraft({ editing: true, value: '', clear: false })}>{configured ? '替换' : '输入'}</Button> : null}
        {configured || replacing ? <Button size="small" danger icon={<DeleteOutlined />} onClick={() => props.onDraft({ editing: false, value: '', clear: true })}>清除</Button> : null}
        <Button size="small" loading={props.testing} disabled={props.draft.clear || (replacing && !props.draft.value.trim())} onClick={props.onValidate}>验证</Button>
      </Space>
      {props.status.message && props.status.state !== 'valid' ? <Typography.Text type="secondary">{props.status.message}</Typography.Text> : null}
      {props.error ? <Typography.Text type="danger">{props.error}</Typography.Text> : null}
      {props.draft.clear ? <Typography.Text type="warning">保存后将清除此凭据</Typography.Text> : null}
    </div>
  )
}

function statusColor(status: CredentialValidation): string {
  if (status === 'valid') return 'success'
  if (status === 'invalid') return 'error'
  if (status === 'unknown') return 'warning'
  return 'default'
}

function SettingField(props: { label: string; children: React.ReactNode }): React.JSX.Element {
  return <label className="setting-field"><span>{props.label}</span>{props.children}</label>
}

function ToggleField(props: { label: string; checked: boolean; onChange(value: boolean): void }): React.JSX.Element {
  return <div className="toggle-field"><span>{props.label}</span><Switch checked={props.checked} onChange={props.onChange} /></div>
}

function ProviderPanel(props: { title: string; children: React.ReactNode }): React.JSX.Element {
  return <div className="provider-panel"><div className="provider-heading"><strong>{props.title}</strong></div>{props.children}</div>
}

function AdvancedModel(props: { baseUrl: string; model: string; onBaseUrl(value: string): void; onModel(value: string): void }): React.JSX.Element {
  return <Collapse ghost size="small" items={[{ key: 'advanced', label: '高级设置', children: <><SettingField label="Base URL"><Input value={props.baseUrl} onChange={(event) => props.onBaseUrl(event.target.value)} /></SettingField><SettingField label="Model ID"><Input value={props.model} onChange={(event) => props.onModel(event.target.value)} /></SettingField></> }]} />
}
