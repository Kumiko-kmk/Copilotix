import React from 'react'
import { DeleteOutlined, HolderOutlined, PlusOutlined } from '@ant-design/icons'
import { Button, Checkbox, Input, Typography } from 'antd'
import type { MessageInstance } from 'antd/es/message/interface'
import { createConnection, MAX_KEYS_PER_PROVIDER, type KeyProvider, type ModelConnection } from '@platform/models/contract/models'
import type { CredentialMutation, KeyStatus, SettingsSaveResult } from '../contract/settingsTypes'

const PROVIDERS: Array<{ id: KeyProvider; label: string }> = [
  { id: 'deepseek', label: 'DeepSeek' },
  { id: 'qwen', label: '千问 / Qwen' }
]

const STATE_LABELS: Record<KeyStatus['state'], string> = { missing: '未配置', unknown: '待验证', valid: '已验证', invalid: '验证失败' }

export function keyLabel(connection: ModelConnection, index: number): string {
  return connection.label || (connection.connectionId.endsWith(':default') ? '默认密钥' : `密钥 ${index + 1}`)
}

/** Unsaved key values, per-key errors and test state; values live only in memory until saved. */
export function useKeyDrafts(messageApi: MessageInstance) {
  const [values, setValues] = React.useState<Record<string, string>>({})
  const [errors, setErrors] = React.useState<Record<string, string>>({})
  const [testing, setTesting] = React.useState<string | null>(null)
  const [live, setLive] = React.useState<Record<string, KeyStatus>>({})

  const setValue = React.useCallback((id: string, value: string | undefined) => {
    setErrors(current => ({ ...current, [id]: '' }))
    setValues(current => {
      const next = { ...current }
      if (value === undefined) delete next[id]
      else next[id] = value
      return next
    })
  }, [])

  const validate = React.useCallback(async (connection: ModelConnection) => {
    const id = connection.connectionId
    const value = values[id]?.trim()
    if (values[id] !== undefined && !value) { setErrors(current => ({ ...current, [id]: '请输入密钥后再测试' })); return }
    setTesting(id)
    try {
      const result = await window.copilotix.validateCredential(connection.provider as KeyProvider, value || undefined, id)
      if (!value) setLive(current => ({ ...current, [id]: { ...current[id], ...result } }))
      if (result.state === 'valid') {
        setErrors(current => ({ ...current, [id]: '' }))
        messageApi.success(value ? '密钥可用，保存后生效' : '密钥验证成功')
      } else {
        const text = result.message ?? '密钥验证失败'
        setErrors(current => ({ ...current, [id]: text }))
        messageApi.error(text)
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      setErrors(current => ({ ...current, [id]: text }))
      messageApi.error(text)
    } finally {
      setTesting(null)
    }
  }, [messageApi, values])

  const mutations = React.useCallback((connections: readonly ModelConnection[]): Record<string, CredentialMutation> | undefined => {
    const result: Record<string, CredentialMutation> = {}
    for (const connection of connections) {
      const value = values[connection.connectionId]?.trim()
      if (value) result[connection.connectionId] = { action: 'set', value }
    }
    return Object.keys(result).length ? result : undefined
  }, [values])

  /** Keeps rows whose key was rejected (new rows included) so the user can fix them without retyping the rest. */
  const applySaveResult = React.useCallback((sent: readonly ModelConnection[], result: SettingsSaveResult): ModelConnection[] => {
    const failed = result.keyErrors ?? {}
    setErrors(Object.fromEntries(Object.entries(failed).map(([id, error]) => [id, error.message])))
    setValues(current => Object.fromEntries(Object.entries(current).filter(([id]) => failed[id])))
    setLive({})
    const saved = result.settings.modelConnections ?? []
    const merged: ModelConnection[] = []
    for (const connection of sent) {
      const stored = saved.find(value => value.connectionId === connection.connectionId)
      if (stored) merged.push(stored)
      else if (failed[connection.connectionId]) merged.push(connection)
    }
    return [...merged, ...saved.filter(value => !merged.some(next => next.connectionId === value.connectionId))]
  }, [])

  const reset = React.useCallback(() => { setValues({}); setErrors({}); setLive({}) }, [])
  const dirty = Object.values(values).some(value => value.trim())
  return { values, errors, testing, live, setLive, setValue, validate, mutations, applySaveResult, reset, dirty }
}

export type KeyDrafts = ReturnType<typeof useKeyDrafts>

export function ApiKeysSection(props: {
  connections: ModelConnection[]
  statuses: Record<string, KeyStatus>
  drafts: KeyDrafts
  saving: boolean
  onChange(connections: ModelConnection[]): void
}): React.JSX.Element {
  const [provider, setProvider] = React.useState<KeyProvider>('deepseek')
  const [label, setLabel] = React.useState('')
  const [value, setValue] = React.useState('')
  const [dragging, setDragging] = React.useState<string | null>(null)
  const now = useCooldownClock(props.statuses)
  const keys = props.connections.filter(connection => connection.provider === provider)
  const others = props.connections.filter(connection => connection.provider !== provider)
  const replace = (next: ModelConnection[]): void => props.onChange([...others, ...next])
  const move = (source: string, target: string): void => {
    const from = keys.findIndex(connection => connection.connectionId === source)
    const to = keys.findIndex(connection => connection.connectionId === target)
    if (from < 0 || to < 0 || from === to) return
    const next = [...keys]
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item!)
    replace(next)
  }
  const update = (id: string, patch: Partial<ModelConnection>): void =>
    replace(keys.map(connection => connection.connectionId === id ? { ...connection, ...patch } : connection))
  const remove = (id: string): void => {
    props.drafts.setValue(id, undefined)
    replace(keys.filter(connection => connection.connectionId !== id))
  }
  const add = (): void => {
    const key = value.trim()
    if (!key || keys.length >= MAX_KEYS_PER_PROVIDER) return
    const connection = createConnection(provider, `${provider}:${crypto.randomUUID()}`, keys.length, label.trim().slice(0, 24) || undefined)
    props.drafts.setValue(connection.connectionId, key)
    replace([...keys, connection])
    setLabel('')
    setValue('')
  }
  const order = keys.filter(connection => connection.enabled).map((connection, index) => keyLabel(connection, index))

  return (
    <section className="settings-section api-keys" aria-label="API 密钥">
      <div className="api-key-tabs" role="tablist" aria-label="服务商">
        {PROVIDERS.map(entry => {
          const count = props.connections.filter(connection => connection.provider === entry.id).length
          return (
            <button key={entry.id} type="button" role="tab" aria-selected={provider === entry.id} className={provider === entry.id ? 'active' : ''} onClick={() => setProvider(entry.id)}>
              {entry.label}<small>{count}/{MAX_KEYS_PER_PROVIDER}</small>
            </button>
          )
        })}
      </div>
      <div className="api-key-card">
        <div className="model-priority-heading">
          <strong>{PROVIDERS.find(entry => entry.id === provider)!.label} 密钥</strong>
          <span className="model-request-order"><span>使用顺序</span><strong>{order.join(' → ') || '未配置'}</strong></span>
        </div>
        <div className="api-key-list" role="list" aria-label="密钥列表">
          {keys.length === 0 ? <Typography.Text className="api-key-empty" type="secondary">尚未添加密钥。添加后按顺序使用，某个密钥限流、冷却或失效时自动换用下一个。</Typography.Text> : null}
          {keys.map((connection, index) => {
            const id = connection.connectionId
            const status = { ...props.statuses[id], ...props.drafts.live[id] } as KeyStatus | Partial<KeyStatus>
            const stored = Boolean(props.statuses[id])
            const draft = props.drafts.values[id]
            const state = keyState(status, stored, draft !== undefined, now)
            return (
              <div
                key={id}
                role="listitem"
                data-key={id}
                className={`api-key-item${dragging === id ? ' dragging' : ''}${connection.enabled ? '' : ' disabled'}`}
                onDragEnter={event => { event.preventDefault(); if (dragging && dragging !== id) move(dragging, id) }}
                onDragOver={event => event.preventDefault()}
              >
                <button
                  type="button"
                  className="model-drag-handle"
                  aria-label={`移动${keyLabel(connection, index)}`}
                  draggable={!props.saving}
                  disabled={props.saving}
                  onDragStart={event => { event.dataTransfer.effectAllowed = 'move'; setDragging(id) }}
                  onDragEnd={() => setDragging(null)}
                  onKeyDown={event => {
                    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
                    event.preventDefault()
                    const target = keys[index + (event.key === 'ArrowUp' ? -1 : 1)]
                    if (target) move(id, target.connectionId)
                  }}
                ><HolderOutlined /></button>
                <Checkbox aria-label={`启用${keyLabel(connection, index)}`} checked={connection.enabled} disabled={props.saving} onChange={() => update(id, { enabled: !connection.enabled })} />
                <span className="model-priority-number">{String(index + 1).padStart(2, '0')}</span>
                <span className="api-key-identity">
                  <Input
                    className="api-key-label"
                    aria-label="密钥名称"
                    variant="borderless"
                    maxLength={24}
                    placeholder={keyLabel(connection, index)}
                    value={connection.label ?? ''}
                    onChange={event => update(id, { label: event.target.value || undefined })}
                  />
                  {draft !== undefined ? (
                    <Input.Password
                      aria-label="新密钥"
                      autoComplete="new-password"
                      visibilityToggle={false}
                      placeholder="粘贴新的 API Key"
                      value={draft}
                      onChange={event => props.drafts.setValue(id, event.target.value)}
                    />
                  ) : <small className="api-key-masked">{status.maskedValue ?? '未保存密钥'}</small>}
                  {props.drafts.errors[id] ? <Typography.Text className="api-key-error" type="danger">{props.drafts.errors[id]}</Typography.Text> : null}
                </span>
                <span className={`credential-status status-${state.state}`}>{state.label}</span>
                <span className="api-key-actions">
                  <Button loading={props.drafts.testing === id} disabled={props.saving || (draft !== undefined && !draft.trim()) || (!stored && draft === undefined)} onClick={() => void props.drafts.validate(connection)}>测试</Button>
                  {stored ? (
                    <Button disabled={props.saving} onClick={() => props.drafts.setValue(id, draft === undefined ? '' : undefined)}>{draft === undefined ? '更换' : '取消'}</Button>
                  ) : null}
                  <Button danger icon={<DeleteOutlined />} aria-label={`删除${keyLabel(connection, index)}`} disabled={props.saving} onClick={() => remove(id)} />
                </span>
              </div>
            )
          })}
        </div>
        <form className="api-key-add" onSubmit={event => { event.preventDefault(); add() }}>
          <Input aria-label="新密钥名称" maxLength={24} placeholder="名称（可选）" value={label} onChange={event => setLabel(event.target.value)} disabled={keys.length >= MAX_KEYS_PER_PROVIDER} />
          <Input.Password aria-label="新 API Key" autoComplete="new-password" visibilityToggle={false} placeholder={keys.length >= MAX_KEYS_PER_PROVIDER ? `最多 ${MAX_KEYS_PER_PROVIDER} 个密钥` : '粘贴 API Key'} value={value} onChange={event => setValue(event.target.value)} disabled={keys.length >= MAX_KEYS_PER_PROVIDER} />
          <Button htmlType="submit" icon={<PlusOutlined />} disabled={!value.trim() || keys.length >= MAX_KEYS_PER_PROVIDER || props.saving}>添加</Button>
        </form>
      </div>
      <Typography.Text className="storage-note" type="secondary">保存时逐个验证新密钥；密钥只存于 Windows 凭据管理器，不进入设置、日志与文库备份。</Typography.Text>
    </section>
  )
}

function keyState(status: Partial<KeyStatus>, stored: boolean, editing: boolean, now: number): { state: KeyStatus['state']; label: string } {
  if (!stored || editing) return { state: 'unknown', label: '待保存' }
  if (status.health === 'rejected') return { state: 'invalid', label: '已被拒绝' }
  if (status.health === 'cooldown' && status.retryAt && status.retryAt > now) {
    const seconds = Math.ceil((status.retryAt - now) / 1000)
    return { state: 'unknown', label: `冷却中 ${seconds >= 60 ? `${Math.ceil(seconds / 60)} 分钟` : `${seconds} 秒`}` }
  }
  const state = status.state ?? 'missing'
  return { state, label: STATE_LABELS[state] }
}

/** Ticks only while some key is cooling down, so the remaining time stays current without asking Main again. */
function useCooldownClock(statuses: Record<string, KeyStatus>): number {
  const [now, setNow] = React.useState(() => Date.now())
  const cooling = Object.values(statuses).some(status => status.health === 'cooldown' && (status.retryAt ?? 0) > now)
  React.useEffect(() => {
    if (!cooling) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [cooling])
  return now
}
