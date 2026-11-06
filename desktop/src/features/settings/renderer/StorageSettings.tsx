import React from 'react'
import { DatabaseOutlined, FileOutlined, FileTextOutlined, FolderOpenOutlined, ReloadOutlined } from '@ant-design/icons'
import { Button, Input } from 'antd'
import type { StorageInfo } from '../contract/settingsSchemas'
import { formatBytes, StorageComposition, StorageGrowth, StorageMetric } from './SettingsDashboards'
import { OpenFolderIcon, RefreshIcon } from './settingsIcons'

export type LibraryAction = 'backup' | 'restore' | 'migrate'

/**
 * 文件存储. The page shows usage with its charts; the settings window keeps to the location,
 * the data actions and one line of usage.
 */
export function StorageSettings(props: {
  compact: boolean
  outputRoot: string
  info: StorageInfo | null
  loading: boolean
  action: LibraryAction | null
  saving: boolean
  onAction(action: LibraryAction): void
  onOpen(): void
  onRefresh(): void
}): React.JSX.Element {
  const { action, info, loading } = props
  const collection = props.compact ? '论文数据' : '文库'
  const actions = (
    <>
      <Button loading={action === 'backup'} disabled={action !== null || props.saving || loading} onClick={() => props.onAction('backup')}>导出{collection}</Button>
      <Button loading={action === 'restore'} disabled={action !== null || props.saving || loading} onClick={() => props.onAction('restore')}>导入{collection}</Button>
      <Button loading={action === 'migrate'} disabled={action !== null || props.saving || loading} onClick={() => props.onAction('migrate')}>迁移{collection}</Button>
    </>
  )
  if (props.compact) {
    const usage = !info ? '—' : info.exists === false ? '尚无文档' : `${info.documentCount} 篇文档 · ${formatBytes(info.totalBytes)}`
    return (
      <section className="settings-section storage-management" aria-label="文件存储">
        <div className="settings-row">
          <span className="settings-row-label">保存位置</span>
          <div className="settings-row-control storage-path">
            <Input aria-label="文档保存位置" readOnly value={props.outputRoot} />
            <Button disabled={action !== null} icon={<OpenFolderIcon />} onClick={props.onOpen}>打开</Button>
          </div>
        </div>
        <div className="settings-row">
          <span className="settings-row-label">论文数据</span>
          <div className="settings-row-control storage-location-actions" aria-busy={action !== null}>{actions}</div>
        </div>
        <div className="settings-row" aria-busy={loading}>
          <span className="settings-row-label">用量</span>
          <div className="settings-row-control storage-usage-line">
            <span>{usage}</span>
            <Button type="text" aria-label="刷新用量" disabled={action !== null} loading={loading} icon={<RefreshIcon />} onClick={props.onRefresh} />
          </div>
        </div>
      </section>
    )
  }
  return (
    <section className="settings-section storage-management" aria-label="文件存储">
      <div className="storage-location-card">
        <label className="storage-location-field">
          <span>保存位置</span>
          <Input aria-label="文档保存位置" readOnly value={props.outputRoot} />
        </label>
        <div className="storage-location-actions" aria-busy={action !== null}>
          {actions}
          <Button disabled={action !== null} icon={<FolderOpenOutlined aria-hidden="true" />} onClick={props.onOpen}>打开当前目录</Button>
        </div>
      </div>
      <div className="storage-usage-card" aria-busy={loading}>
        <div className="storage-usage-heading">
          <span><strong>存储用量</strong>{info?.exists === false ? <small>文档目录尚未建立</small> : null}</span>
          <Button disabled={action !== null} icon={<ReloadOutlined />} loading={loading} onClick={props.onRefresh}>刷新用量</Button>
        </div>
        <div className="storage-usage-grid">
          <StorageMetric icon={<FileTextOutlined />} label="文档" value={info ? String(info.documentCount) : '—'} />
          <StorageMetric icon={<FileOutlined />} label="文件" value={info ? String(info.fileCount) : '—'} />
          <StorageMetric icon={<DatabaseOutlined />} label="占用空间" value={info ? formatBytes(info.totalBytes) : '—'} />
        </div>
      </div>
      <div className="storage-insights">
        <StorageComposition info={info} />
        <StorageGrowth info={info} />
      </div>
    </section>
  )
}
