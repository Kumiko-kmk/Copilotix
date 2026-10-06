import React from 'react'
import { DeleteOutlined, FileMarkdownOutlined, FilePdfOutlined, FolderOpenOutlined, RedoOutlined, SearchOutlined } from '@ant-design/icons'
import { Button, Checkbox, Empty, Input, Modal, Table, Tag, Typography, message } from 'antd'
import type { InputRef } from 'antd'
import type { DocumentSummary } from '@shared/ipcSchemas'

type WorkflowStatus = DocumentSummary['workflow']['status']
type StatusFilter = 'all' | 'active' | 'completed' | 'attention'

const statusLabels: Record<WorkflowStatus, string> = {
  queued: '排队中', uploading: '上传中', parsing: '解析中', translating: '翻译中',
  partial: '部分完成', completed: '已完成', failed: '失败'
}
const ACTIVE_STATUSES = new Set<WorkflowStatus>(['queued', 'uploading', 'parsing', 'translating'])
const ATTENTION_STATUSES = new Set<WorkflowStatus>(['failed', 'partial'])

function matchesStatus(status: WorkflowStatus, filter: StatusFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'active') return ACTIVE_STATUSES.has(status)
  if (filter === 'attention') return ATTENTION_STATUSES.has(status)
  return status === filter
}

export default function TasksPage(props: { documents: DocumentSummary[]; onOpen(documentId: string): void; onCreate?(): void }): React.JSX.Element {
  const [query, setQuery] = React.useState('')
  const [status, setStatus] = React.useState<StatusFilter>('all')
  const [deleting, setDeleting] = React.useState<DocumentSummary | null>(null)
  const [deleteFiles, setDeleteFiles] = React.useState(true)
  const [messageApi, contextHolder] = message.useMessage()
  const searchRef = React.useRef<InputRef>(null)
  const retry = React.useCallback(async (documentId: string) => {
    try {
      await window.copilotix.retryDocument(documentId)
      messageApi.success('已重新排队，将保留已完成的译文')
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : String(error))
    }
  }, [messageApi])

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return
      event.preventDefault()
      searchRef.current?.focus()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const counts = React.useMemo(() => ({
    all: props.documents.length,
    active: props.documents.filter((document) => ACTIVE_STATUSES.has(document.workflow.status)).length,
    completed: props.documents.filter((document) => document.workflow.status === 'completed').length,
    attention: props.documents.filter((document) => ATTENTION_STATUSES.has(document.workflow.status)).length
  }), [props.documents])

  const filtered = React.useMemo(
    () => props.documents.filter((document) => document.displayName.toLowerCase().includes(query.toLowerCase()) && matchesStatus(document.workflow.status, status)),
    [props.documents, query, status]
  )

  const remove = React.useCallback(async () => {
    if (!deleting) return
    try {
      await window.copilotix.deleteDocument({ documentId: deleting.id, deleteFiles })
      setDeleting(null)
      setDeleteFiles(true)
      messageApi.success('任务已删除')
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : String(error))
    }
  }, [deleteFiles, deleting, messageApi])

  const clearFilters = React.useCallback(() => {
    setQuery('')
    setStatus('all')
  }, [])
  const filtering = query !== '' || status !== 'all'

  return (
    <section className="page tasks-page">
      {contextHolder}
      <header className="page-header task-header">
        <Typography.Title level={2}>全部任务</Typography.Title>
      </header>
      <div className="task-toolbar">
        <div className="task-overview" role="group" aria-label="按状态筛选">
          <OverviewChip tone="all" label="全部" count={counts.all} active={status === 'all'} onClick={() => setStatus('all')} />
          <OverviewChip tone="active" label="处理中" count={counts.active} active={status === 'active'} onClick={() => setStatus('active')} />
          <OverviewChip tone="completed" label="完成" count={counts.completed} active={status === 'completed'} onClick={() => setStatus('completed')} />
          <OverviewChip tone="attention" label="需处理" count={counts.attention} active={status === 'attention'} onClick={() => setStatus('attention')} />
        </div>
        <Input ref={searchRef} className="task-search" allowClear prefix={<SearchOutlined />} suffix={query ? null : <kbd className="task-search-hint">/</kbd>} placeholder="请输入任务名称" value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>
      <Table
        rowKey="id"
        dataSource={filtered}
        tableLayout="fixed"
        locale={{
          emptyText: filtering
            ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的任务"><Button onClick={clearFilters}>清除筛选</Button></Empty>
            : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有任务">{props.onCreate ? <Button type="primary" onClick={props.onCreate}>去新解析</Button> : null}</Empty>
        }}
        rowClassName={(document) => `task-row status-${document.workflow.status}`}
        pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (total) => `共 ${total} 项`, hideOnSinglePage: false }}
        onRow={(document) => ({ onDoubleClick: () => props.onOpen(document.id) })}
        columns={[
          {
            title: '任务名称', dataIndex: 'displayName', width: '43%', align: 'center', ellipsis: true,
            render: (name: string, document: DocumentSummary) => (
              <div className="task-name">
                <span className="task-file-icon" aria-hidden="true">{documentTypeLabel(document.originalName) === 'PDF' ? <FilePdfOutlined /> : <FileMarkdownOutlined />}</span>
                <button className="task-link" title={name} onClick={() => props.onOpen(document.id)}>{name}</button>
              </div>
            )
          },
          {
            title: '状态', width: '15%', align: 'center',
            render: (_: unknown, document: DocumentSummary) => document.workflow.status === 'translating' ? (
              <div className="task-status">
                <div
                  className="task-status-active"
                  style={{ '--task-progress': `${Math.max(0, Math.min(100, document.workflow.progress))}%` } as React.CSSProperties}
                  role="progressbar"
                  aria-label={statusLabels[document.workflow.status]}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={document.workflow.progress}
                  title={`翻译进度 ${document.workflow.progress}%`}
                >
                  <span>{statusLabels[document.workflow.status]}</span>
                </div>
              </div>
            ) : <div className="task-status"><Tag color={statusColor(document.workflow.status)}>{statusLabels[document.workflow.status]}</Tag></div>
          },
          {
            title: '类型', width: '10%', align: 'center',
            render: (_: unknown, document: DocumentSummary) => {
              const type = documentTypeLabel(document.originalName)
              return <Tag className="task-type" color={type === 'PDF' ? 'red' : 'blue'}>{type}</Tag>
            }
          },
          { title: '创建时间', dataIndex: 'createdAt', width: '17%', align: 'center', render: (value: string) => <span className="task-time">{formatTaskCreatedAt(value)}</span> },
          {
            title: '操作', width: '15%', align: 'center',
            render: (_: unknown, document: DocumentSummary) => (
              <div className="task-actions">
                <Button type="text" aria-label="打开输出目录" title="打开输出目录" icon={<FolderOpenOutlined />} onClick={() => void window.copilotix.openDocumentOutput(document.id)} />
                {document.workflow.status === 'failed' || document.workflow.status === 'partial' || document.workflow.status === 'translating'
                  ? <Button type="text" aria-label="重试" title={document.workflow.status === 'translating' ? '中断当前翻译并保留已完成区块后重试' : '重试失败区块'} icon={<RedoOutlined />} onClick={() => void retry(document.id)} />
                  : <span className="task-action-placeholder" aria-hidden="true" />}
                <Button danger type="text" aria-label="删除" title="删除任务" icon={<DeleteOutlined />} onClick={() => { setDeleteFiles(true); setDeleting(document) }} />
              </div>
            )
          }
        ]}
      />
      <Modal title="删除任务" open={Boolean(deleting)} okText="删除" okButtonProps={{ danger: true }} onOk={() => void remove()} onCancel={() => setDeleting(null)}>
        <p>确定从任务列表删除“{deleting?.displayName}”吗？</p>
        <Checkbox checked={deleteFiles} onChange={(event) => setDeleteFiles(event.target.checked)}>同时删除本地结果文件（不可恢复）</Checkbox>
      </Modal>
    </section>
  )
}

function OverviewChip(props: { tone: string; label: string; count: number; active: boolean; onClick(): void }): React.JSX.Element {
  return (
    <button type="button" className={`task-chip tone-${props.tone}${props.active ? ' active' : ''}`} aria-pressed={props.active} aria-label={`${props.label} ${props.count}`} onClick={props.onClick}>
      <i aria-hidden="true" />
      <span>{props.label}</span>
      <strong>{props.count}</strong>
    </button>
  )
}

function statusColor(status: WorkflowStatus): string {
  if (status === 'completed') return 'success'
  if (status === 'failed') return 'error'
  if (status === 'partial') return 'warning'
  return 'processing'
}

export function documentTypeLabel(originalName: string): 'PDF' | 'Markdown' {
  return /\.(?:md|markdown)$/iu.test(originalName.trim()) ? 'Markdown' : 'PDF'
}

export function formatTaskCreatedAt(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (part: number): string => String(part).padStart(2, '0')
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
