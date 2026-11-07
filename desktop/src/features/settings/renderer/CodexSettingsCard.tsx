import React from 'react'
import { useCodexStatus, refreshCodexStatus, loadCachedCodexStatus } from './codexStatusClient'
import { Button, Input, Select } from 'antd'
import { DEFAULT_CODEX_SETTINGS, type CodexSettings, type CodexStatus } from '@platform/codex/contract/codex'
import { ServiceCard, type ServiceState } from './ServiceCard'

const STATE: Record<CodexStatus['state'], { state: ServiceState; label: string }> = {
  ready: { state: 'valid', label: '已登录' },
  'signed-out': { state: 'invalid', label: '未登录' },
  missing: { state: 'invalid', label: '未找到' },
  unavailable: { state: 'invalid', label: '不可用' }
}

export function CodexSettingsCard({ value = DEFAULT_CODEX_SETTINGS, onChange }: { value?: CodexSettings; onChange(value: CodexSettings): void }): React.JSX.Element {
  const status = useCodexStatus(value)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const mounted = React.useRef(true)
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const inspect = async (): Promise<void> => {
    if (busy) return
    setBusy(true); setError('')
    try {
      let result = await refreshCodexStatus(value)
      if (!mounted.current || result.state !== 'ready') return
      const defaultModel = result.models.find(model => model.isDefault)?.id ?? result.models[0]?.id ?? ''
      const next = { ...value, executable: result.executable, translationModel: value.translationModel || defaultModel, chatModel: value.chatModel || defaultModel }
      onChange(next)
      const models = [...new Set([next.translationModel, next.chatModel])].filter(Boolean)
      if (!models.length || models.some(id => !result.models.some(model => model.id === id))) {
        setError('请选择可用的 Codex 模型')
        return
      }
      for (const testModel of models) {
        result = await refreshCodexStatus(next, testModel)
        if (!mounted.current || result.state !== 'ready') break
      }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : '无法检测 Codex') }
    finally { if (mounted.current) setBusy(false) }
  }
  React.useEffect(() => {
    void loadCachedCodexStatus(value)
  }, [value.executable, value.effort])
  const choose = async (): Promise<void> => {
    try {
      const executable = await window.copilotix.codex.selectExecutable()
      if (executable && mounted.current) { onChange({ ...value, executable }) }
    } catch { if (mounted.current) setError('无法选择 Codex 程序') }
  }
  const options = status?.models.map(model => ({ value: model.id, label: `${model.name}${model.image ? ' · 识图' : ''}`, title: '' })) ?? []
  const selected = status?.models.filter(model => [value.translationModel, value.chatModel].includes(model.id)) ?? []
  const efforts = selected.length ? selected[0]!.efforts.filter(effort => selected.every(model => model.efforts.includes(effort))) : []
  const models = [...new Set([value.translationModel, value.chatModel])].filter(Boolean)
  const verified = models.length > 0 && models.every(model => status?.verifiedModels.includes(model))
  const state = error ? { state: 'invalid' as const, label: '检测失败' } : status?.state === 'ready' && verified ? { state: 'valid' as const, label: '验证成功' } : status ? STATE[status.state] : { state: 'unknown' as const, label: '未检测' }
  const message = error || (status ? `${status.version} ${status.message}${verified ? ' · 所选模型已测试' : ''}`.trim() : '')
  const disabled = busy || !options.length
  return (
    <ServiceCard
      title="Codex"
      name="codex"
      label="Codex 连接"
      state={state.state}
      stateLabel={state.label}
      footer={<>
        <div className="codex-model-fields">
          <Select title="" aria-label="Codex 翻译模型" prefix="翻译" placeholder="检测后选择" value={value.translationModel || undefined} options={options} disabled={disabled} popupMatchSelectWidth={false} onChange={translationModel => onChange({ ...value, translationModel })} />
          <Select title="" aria-label="Codex 问答模型" prefix="问答" placeholder="检测后选择" value={value.chatModel || undefined} options={options} disabled={disabled} popupMatchSelectWidth={false} onChange={chatModel => onChange({ ...value, chatModel })} />
        </div>
        {message ? <p className="codex-message" role="status">{message}</p> : null}
      </>}
    >
      {/* Everything on the row itself: no collapsed advanced section. */}
      <div className="credential-editor">
        <label className="credential-label" htmlFor="codex-executable">程序</label>
        <div className="credential-control">
          <Input id="codex-executable" readOnly value={value.executable} placeholder="自动检测本机安装" />
        </div>
        <div className="credential-actions">
          <Button disabled={busy} onClick={() => void choose()}>选择程序</Button>
          <Button className="credential-validate" loading={busy} onClick={() => void inspect()}>验证连接</Button>
        </div>
      </div>
      <Select className="codex-effort" title="" aria-label="Codex 推理强度" prefix="推理" value={value.effort ?? 'default'} disabled={busy} popupMatchSelectWidth={false} options={[{ value: 'default', label: '模型默认', title: '' }, ...efforts.map(effort => ({ value: effort, label: effort, title: '' }))]} onChange={effort => onChange({ ...value, effort: effort === 'default' ? null : effort as CodexSettings['effort'] })} />
    </ServiceCard>
  )
}
