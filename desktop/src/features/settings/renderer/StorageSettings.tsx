import React from 'react'
import { DatabaseOutlined, FileOutlined, FileTextOutlined, FolderOpenOutlined, ReloadOutlined } from '@ant-design/icons'
import { Button, Input } from 'antd'
import type { StorageInfo } from '../contract/settingsSchemas'
import { formatBytes, StorageComposition, StorageGrowth, StorageMetric } from './SettingsDashboards'
import { OpenFolderIcon } from './settingsIcons'

export type LibraryAction = 'backup' | 'restore' | 'migrate'

/**
 * 檔案儲存. The page shows usage with its charts; the settings window keeps to the location
 * and the data actions.
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
  const collection = props.compact ? '論文資料' : '文庫'
  const actions = (
    <>
      <Button loading={action === 'backup'} disabled={action !== null || props.saving || loading} onClick={() => props.onAction('backup')}>匯出{collection}</Button>
      <Button loading={action === 'restore'} disabled={action !== null || props.saving || loading} onClick={() => props.onAction('restore')}>匯入{collection}</Button>
      <Button loading={action === 'migrate'} disabled={action !== null || props.saving || loading} onClick={() => props.onAction('migrate')}>遷移{collection}</Button>
    </>
  )
  if (props.compact) {
    return (
      <section className="settings-section storage-management" aria-label="儲存">
        <div className="settings-row">
          <span className="settings-row-label">儲存位置</span>
          <div className="settings-row-control storage-path">
            <Input aria-label="文件儲存位置" readOnly value={props.outputRoot} />
            <Button disabled={action !== null} icon={<OpenFolderIcon />} onClick={props.onOpen}>開啟</Button>
          </div>
        </div>
        <div className="settings-row">
          <span className="settings-row-label">論文資料</span>
          <div className="settings-row-control storage-location-actions" aria-busy={action !== null}>{actions}</div>
        </div>
      </section>
    )
  }
  return (
    <section className="settings-section storage-management" aria-label="檔案儲存">
      <div className="storage-location-card">
        <label className="storage-location-field">
          <span>儲存位置</span>
          <Input aria-label="文件儲存位置" readOnly value={props.outputRoot} />
        </label>
        <div className="storage-location-actions" aria-busy={action !== null}>
          {actions}
          <Button disabled={action !== null} icon={<FolderOpenOutlined aria-hidden="true" />} onClick={props.onOpen}>開啟當前目錄</Button>
        </div>
      </div>
      <div className="storage-usage-card" aria-busy={loading}>
        <div className="storage-usage-heading">
          <span><strong>儲存用量</strong>{info?.exists === false ? <small>文件目錄尚未建立</small> : null}</span>
          <Button disabled={action !== null} icon={<ReloadOutlined />} loading={loading} onClick={props.onRefresh}>重新整理用量</Button>
        </div>
        <div className="storage-usage-grid">
          <StorageMetric icon={<FileTextOutlined />} label="文件" value={info ? String(info.documentCount) : '—'} />
          <StorageMetric icon={<FileOutlined />} label="檔案" value={info ? String(info.fileCount) : '—'} />
          <StorageMetric icon={<DatabaseOutlined />} label="佔用空間" value={info ? formatBytes(info.totalBytes) : '—'} />
        </div>
      </div>
      <div className="storage-insights">
        <StorageComposition info={info} />
        <StorageGrowth info={info} />
      </div>
    </section>
  )
}
