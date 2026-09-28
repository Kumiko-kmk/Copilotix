import React from 'react'
import { DeleteOutlined, FolderOpenOutlined, RedoOutlined, SearchOutlined } from '@ant-design/icons'
import { Button, Checkbox, Input, Modal, Select, Space, Table, Tag, Typography, message } from 'antd'
import type { DocumentSummary } from '@shared/ipcSchemas'

const statusLabels: Record<DocumentSummary['workflow']['status'], string> = {
  queued: '排队中', uploading: '上传中', parsing: '解析中', translating: '翻译中',
  partial: '部分完成', completed: '已完成', failed: '失败'
}

export default function TasksPage(props: { documents: DocumentSummary[]; onOpen(documentId: string): void }): React.JSX.Element {
  const [query, setQuery] = React.useState('')
  const [status, setStatus] = React.useState<DocumentSummary['workflow']['status'] | 'all'>('all')
  const [deleting, setDeleting] = React.useState<DocumentSummary | null>(null)
  const [deleteFiles, setDeleteFiles] = React.useState(true)
  const [messageApi, contextHolder] = message.useMessage()
  const retry = React.useCallback(async (documentId: string) => {
    try {
      await window.copilotix.retryDocument(documentId)
      messageApi.success('已重新排队，将保留已完成的译文')
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : String(error))
    }
  }, [messageApi])

  const filtered = React.useMemo(
    () => props.documents.filter((document) => document.displayName.toLowerCase().includes(query.toLowerCase()) && (status === 'all' || document.workflow.status === status)),
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

  return (
    <section className="page tasks-page">
      {contextHolder}
      <header className="page-header task-header">
        <Typography.Title level={2}>全部任务</Typography.Title>
        <Space>
          <Input allowClear prefix={<SearchOutlined />} placeholder="请输入任务名称" value={query} onChange={(event) => setQuery(event.target.value)} />
          <Select value={status} onChange={setStatus} options={[{ value: 'all', label: '全部状态' }, ...Object.entries(statusLabels).map(([value, label]) => ({ value, label }))]} />
        </Space>
      </header>
      <Table
        rowKey="id"
        dataSource={filtered}
        tableLayout="fixed"
        pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (total) => `共 ${total} 项` }}
        onRow={(document) => ({ onDoubleClick: () => props.onOpen(document.id) })}
        columns={[
          {
            title: '任务名称', dataIndex: 'displayName', width: '43%', align: 'center', ellipsis: true,
            render: (name: string, document: DocumentSummary) => <button className="task-link" onClick={() => props.onOpen(document.id)}>{name}</button>
          },
          {
            title: '状态', width: '15%', align: 'center',
            onCell: (document: DocumentSummary) => isFilledStatus(document.workflow.status) ? {
              className: 'task-progress-cell',
              style: { '--task-progress': `${Math.max(0, Math.min(100, document.workflow.progress))}%` } as React.CSSProperties
            } : {},
            render: (_: unknown, document: DocumentSummary) => isFilledStatus(document.workflow.status) ? (
              <div className="task-status task-status-active" role="progressbar" aria-label={statusLabels[document.workflow.status]} aria-valuemin={0} aria-valuemax={100} aria-valuenow={document.workflow.progress}>
                {statusLabels[document.workflow.status]}
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
          { title: '创建时间', dataIndex: 'createdAt', width: '17%', align: 'center', render: (value: string) => formatTaskCreatedAt(value) },
          {
            title: '操作', width: '15%', align: 'center',
            render: (_: unknown, document: DocumentSummary) => (
              <div className="task-actions">
                <Button type="text" aria-label="打开输出目录" icon={<FolderOpenOutlined />} onClick={() => void window.copilotix.openDocumentOutput(document.id)} />
                {document.workflow.status === 'failed' || document.workflow.status === 'partial' || document.workflow.status === 'translating'
                  ? <Button type="text" aria-label="重试" title={document.workflow.status === 'translating' ? '中断当前翻译并保留已完成区块后重试' : '重试失败区块'} icon={<RedoOutlined />} onClick={() => void retry(document.id)} />
                  : <span className="task-action-placeholder" aria-hidden="true" />}
                <Button danger type="text" aria-label="删除" icon={<DeleteOutlined />} onClick={() => { setDeleteFiles(true); setDeleting(document) }} />
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

function isFilledStatus(status: DocumentSummary['workflow']['status']): boolean {
  return status === 'queued' || status === 'translating'
}

function statusColor(status: DocumentSummary['workflow']['status']): string {
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
