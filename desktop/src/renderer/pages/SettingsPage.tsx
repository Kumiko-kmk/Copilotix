import React from 'react'
import { ApiOutlined, FolderOpenOutlined, SettingOutlined } from '@ant-design/icons'
import { Alert, Button, Collapse, Input, Radio, Select, Space, Switch, Typography, message } from 'antd'
import { PROVIDER_LABELS } from '@shared/constants'
import type { AppSettings, SettingsUpdate, TranslationProviderId } from '@shared/types'

type Section = 'system' | 'parameters'

export default function SettingsPage(props: {
  settings: AppSettings
  onSaved(settings: AppSettings): void
}): React.JSX.Element {
  const [section, setSection] = React.useState<Section>('system')
  const [draft, setDraft] = React.useState<AppSettings>(props.settings)
  const [parserToken, setParserToken] = React.useState('')
  const [qwenKey, setQwenKey] = React.useState('')
  const [deepseekKey, setDeepseekKey] = React.useState('')
  const [testing, setTesting] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [messageApi, contextHolder] = message.useMessage()

  React.useEffect(() => setDraft(props.settings), [props.settings])

  const update = React.useCallback(<K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setDraft((current) => ({ ...current, [key]: value }))
  }, [])

  const chooseOutput = React.useCallback(async () => {
    const path = await window.mineru.chooseOutputDirectory()
    if (path) update('outputRoot', path)
  }, [update])

  const save = React.useCallback(async () => {
    setSaving(true)
    try {
      const payload: SettingsUpdate = {
        ...draft,
        parserToken: parserToken || undefined,
        qwenApiKey: qwenKey || undefined,
        deepseekApiKey: deepseekKey || undefined
      }
      const next = await window.mineru.saveSettings(payload)
      props.onSaved(next)
      setParserToken('')
      setQwenKey('')
      setDeepseekKey('')
      messageApi.success('设置已保存')
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }, [deepseekKey, draft, messageApi, parserToken, props.onSaved, qwenKey])

  const testParser = React.useCallback(async () => {
    setTesting('parser')
    const result = await window.mineru.testParserConnection(parserToken || undefined)
    setTesting(null)
    result.ok ? messageApi.success(result.message) : messageApi.error(result.message)
  }, [messageApi, parserToken])

  const testProvider = React.useCallback(async (provider: TranslationProviderId) => {
    setTesting(provider)
    if ((provider === 'qwen' && qwenKey) || (provider === 'deepseek' && deepseekKey)) await save()
    const result = await window.mineru.testTranslationProvider(provider)
    setTesting(null)
    result.ok ? messageApi.success(result.message) : messageApi.error(result.message)
  }, [deepseekKey, messageApi, qwenKey, save])

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
              <Typography.Title level={4}>MinerU API</Typography.Title>
              <SettingField label="服务地址">
                <Input value="https://mineru.net" readOnly />
              </SettingField>
              <SettingField label={`Bearer Token${draft.hasParserToken ? '（已保存）' : '（必填）'}`}>
                <Input.Password value={parserToken} onChange={(event) => setParserToken(event.target.value)} placeholder={draft.hasParserToken ? '留空则使用已保存 Token' : '输入 MinerU API Token'} />
              </SettingField>
              <Button loading={testing === 'parser'} disabled={!parserToken && !draft.hasParserToken} onClick={() => void testParser()}>验证 Token</Button>
              <Typography.Title level={4} className="settings-subtitle">结果保存</Typography.Title>
              <SettingField label="解析结果保存至">
                <Space.Compact block><Input readOnly value={draft.outputRoot} /><Button icon={<FolderOpenOutlined />} onClick={() => void chooseOutput()}>更换</Button></Space.Compact>
              </SettingField>
            </>
          ) : (
            <>
              <Typography.Title level={4}>解析参数</Typography.Title>
              <SettingField label="模型版本">
                <Radio.Group value={draft.parserModel} onChange={(event) => update('parserModel', event.target.value)}>
                  <Radio value="vlm">MinerU VLM</Radio><Radio value="pipeline">MinerU</Radio>
                </Radio.Group>
              </SettingField>
              <ToggleField label="强制开启 OCR" checked={draft.forceOcr} onChange={(value) => update('forceOcr', value)} />
              <ToggleField label="开启公式识别" checked={draft.formulaEnabled} onChange={(value) => update('formulaEnabled', value)} />
              <ToggleField label="开启表格识别" checked={draft.tableEnabled} onChange={(value) => update('tableEnabled', value)} />
              <SettingField label="OCR 识别语言">
                <Select value={draft.ocrLanguage} onChange={(value) => update('ocrLanguage', value)} options={[{ value: 'ch', label: '中文/英文' }, { value: 'en', label: '英文' }, { value: 'japan', label: '日文' }, { value: 'korean', label: '韩文' }]} />
              </SettingField>

              <Typography.Title level={4} className="settings-subtitle">自动翻译</Typography.Title>
              <SettingField label="默认翻译模型">
                <Select<TranslationProviderId> value={draft.translationProvider} onChange={(value) => update('translationProvider', value)} options={Object.entries(PROVIDER_LABELS).map(([value, label]) => ({ value: value as TranslationProviderId, label }))} />
              </SettingField>
              <ProviderPanel title="千问" configured={draft.qwenHasApiKey} testing={testing === 'qwen'} onTest={() => void testProvider('qwen')}>
                <SettingField label="API Key"><Input.Password value={qwenKey} onChange={(event) => setQwenKey(event.target.value)} placeholder={draft.qwenHasApiKey ? '已保存；留空则不修改' : '请输入 DashScope API Key'} /></SettingField>
                <AdvancedModel baseUrl={draft.qwenBaseUrl} model={draft.qwenModel} onBaseUrl={(value) => update('qwenBaseUrl', value)} onModel={(value) => update('qwenModel', value)} />
              </ProviderPanel>
              <ProviderPanel title="DeepSeek" configured={draft.deepseekHasApiKey} testing={testing === 'deepseek'} onTest={() => void testProvider('deepseek')}>
                <SettingField label="API Key"><Input.Password value={deepseekKey} onChange={(event) => setDeepseekKey(event.target.value)} placeholder={draft.deepseekHasApiKey ? '已保存；留空则不修改' : '请输入 DeepSeek API Key'} /></SettingField>
                <AdvancedModel baseUrl={draft.deepseekBaseUrl} model={draft.deepseekModel} onBaseUrl={(value) => update('deepseekBaseUrl', value)} onModel={(value) => update('deepseekModel', value)} />
              </ProviderPanel>
              <Alert type="warning" showIcon message="Bing 与腾讯 TranSmart 使用非官方网页接口" description="接口可能限流或随时失效；客户端会自动重试并切换其他已配置翻译源。" />
              <Space className="experimental-tests"><Button loading={testing === 'bing'} onClick={() => void testProvider('bing')}>测试 Bing</Button><Button loading={testing === 'transmart'} onClick={() => void testProvider('transmart')}>测试 TranSmart</Button></Space>
            </>
          )}
          <div className="settings-actions"><Button type="primary" size="large" loading={saving} onClick={() => void save()}>保存设置</Button></div>
        </div>
      </div>
    </section>
  )
}

function SettingField(props: { label: string; children: React.ReactNode }): React.JSX.Element {
  return <label className="setting-field"><span>{props.label}</span>{props.children}</label>
}

function ToggleField(props: { label: string; checked: boolean; onChange(value: boolean): void }): React.JSX.Element {
  return <div className="toggle-field"><span>{props.label}</span><Switch checked={props.checked} onChange={props.onChange} /></div>
}

function ProviderPanel(props: { title: string; configured: boolean; testing: boolean; onTest(): void; children: React.ReactNode }): React.JSX.Element {
  return <div className="provider-panel"><div className="provider-heading"><strong>{props.title}</strong><Space><Typography.Text type={props.configured ? 'success' : 'secondary'}>{props.configured ? '密钥已保存' : '尚未配置'}</Typography.Text><Button size="small" loading={props.testing} onClick={props.onTest}>测试</Button></Space></div>{props.children}</div>
}

function AdvancedModel(props: { baseUrl: string; model: string; onBaseUrl(value: string): void; onModel(value: string): void }): React.JSX.Element {
  return <Collapse ghost size="small" items={[{ key: 'advanced', label: '高级设置', children: <><SettingField label="Base URL"><Input value={props.baseUrl} onChange={(event) => props.onBaseUrl(event.target.value)} /></SettingField><SettingField label="Model ID"><Input value={props.model} onChange={(event) => props.onModel(event.target.value)} /></SettingField></> }]} />
}
