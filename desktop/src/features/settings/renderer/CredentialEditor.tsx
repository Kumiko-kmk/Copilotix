import React from 'react'
import { DeleteOutlined } from '@ant-design/icons'
import { Button, Input, Typography } from 'antd'
import type { CredentialName, CredentialStatus } from '../contract/settingsTypes'

export interface DraftCredential {
  value: string
  editing: boolean
  clear: boolean
}

export function initialCredentialDraft(status: CredentialStatus): DraftCredential {
  return { value: '', editing: status.state === 'missing', clear: false }
}

export function CredentialEditor(props: {
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
