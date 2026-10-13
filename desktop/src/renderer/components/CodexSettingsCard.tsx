import React from 'react'
import { Button, Input, Select } from 'antd'
import { DEFAULT_CODEX_SETTINGS, type CodexSettings, type CodexStatus } from '@shared/codex'
import { ServiceCard, type ServiceState } from './ServiceCard'

const STATE: Record<CodexStatus['state'], { state: ServiceState; label: string }> = {
  ready: { state: 'valid', label: '已登录' },
  'signed-out': { state: 'invalid', label: '未登录' },
  missing: { state: 'invalid', label: '未找到' },
  unavailable: { state: 'invalid', label: '不可用' }
}

export function CodexSettingsCard({ value = DEFAULT_CODEX_SETTINGS, onChange }: { value?: CodexSettings; onChange(value: CodexSettings): void }): React.JSX.Element {
  const [status, setStatus] = React.useState<CodexStatus | null>(null)
  const [busy, setBusy] = React.useState<'inspect' | 'test' | null>(null)
  const [error, setError] = React.useState('')
  const mounted = React.useRef(true)
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const inspect = async (testModels: string[] = []): Promise<void> => {
    setBusy(testModels.length ? 'test' : 'inspect'); setError('')
    try {
      let result: CodexStatus | undefined
      for (const testModel of testModels.length ? testModels : [undefined]) {
        result = await window.copilotix.codex.inspect({ settings: value, ...(testModel ? { testModel } : {}) })
        if (result.state !== 'ready') break
      }
      if (!mounted.current || !result) return
      setStatus(result)
      if (result.state === 'ready') {
        const defaultModel = result.models.find(model => model.isDefault)?.id ?? result.models[0]?.id ?? ''
        if (!value.translationModel || !value.chatModel) onChange({ ...value, translationModel: value.translationModel || defaultModel, chatModel: value.chatModel || defaultModel })
      }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : '无法检测 Codex') }
    finally { if (mounted.current) setBusy(null) }
  }
  const choose = async (): Promise<void> => {
    try {
      const executable = await window.copilotix.codex.selectExecutable()
      if (executable && mounted.current) { onChange({ ...value, executable }); setStatus(null) }
    } catch { setError('无法选择 Codex 程序') }
  }
  const options = status?.models.map(model => ({ value: model.id, label: `${model.name}${model.image ? ' · 识图' : ''}`, title: '' })) ?? []
  const selected = status?.models.filter(model => [value.translationModel, value.chatModel].includes(model.id)) ?? []
  const efforts = selected.length ? selected[0]!.efforts.filter(effort => selected.every(model => model.efforts.includes(effort))) : []
  const models = [...new Set([value.translationModel, value.chatModel])].filter(Boolean)
  const verified = models.length > 0 && models.every(model => status?.verifiedModels.includes(model))
  const state = error ? { state: 'invalid' as const, label: '检测失败' } : status ? STATE[status.state] : { state: 'unknown' as const, label: '未检测' }
  const message = error || (status ? `${status.version} ${status.message}${verified ? ' · 所选模型已测试' : ''}`.trim() : '')
  const disabled = busy !== null || !options.length
  return (
    <ServiceCard
      title="Codex"
      badge="可选"
      name="codex"
      label="Codex 连接"
      state={state.state}
      stateLabel={state.label}
      footer={<>
        <div className="codex-model-fields">
          <Select title="" variant="underlined" aria-label="Codex 翻译模型" prefix="翻译" placeholder="检测后选择" value={value.translationModel || undefined} options={options} disabled={disabled} popupMatchSelectWidth={false} onChange={translationModel => onChange({ ...value, translationModel })} />
          <Select title="" variant="underlined" aria-label="Codex 问答模型" prefix="问答" placeholder="检测后选择" value={value.chatModel || undefined} options={options} disabled={disabled} popupMatchSelectWidth={false} onChange={chatModel => onChange({ ...value, chatModel })} />
          <Select title="" variant="underlined" aria-label="Codex 推理强度" prefix="推理" value={value.effort ?? 'default'} disabled={busy !== null} popupMatchSelectWidth={false} options={[{ value: 'default', label: '模型默认', title: '' }, ...efforts.map(effort => ({ value: effort, label: effort, title: '' }))]} onChange={effort => onChange({ ...value, effort: effort === 'default' ? null : effort as CodexSettings['effort'] })} />
          <Button loading={busy === 'test'} disabled={busy !== null || status?.state !== 'ready' || !models.length} onClick={() => void inspect(models)}>测试模型</Button>
        </div>
        {message ? <p className="codex-message" role="status">{message}</p> : null}
      </>}
    >
      <div className="credential-editor">
        <label className="credential-label" htmlFor="codex-executable">程序</label>
        <div className="credential-control">
          <Input id="codex-executable" readOnly value={value.executable} placeholder="自动检测本机安装" />
        </div>
        <div className="credential-actions">
          {value.executable ? <Button disabled={busy !== null} onClick={() => { onChange({ ...value, executable: '' }); setStatus(null) }}>自动检测</Button> : null}
          <Button disabled={busy !== null} onClick={() => void choose()}>选择程序</Button>
          <Button className="credential-validate" loading={busy === 'inspect'} disabled={busy !== null} onClick={() => void inspect()}>检测连接</Button>
        </div>
      </div>
    </ServiceCard>
  )
}
