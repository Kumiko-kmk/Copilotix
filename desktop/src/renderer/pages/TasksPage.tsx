import React from 'react'
import { DeleteOutlined, FolderOpenOutlined, RedoOutlined, SearchOutlined } from '@ant-design/icons'
import { Button, Checkbox, Input, Modal, Progress, Select, Space, Table, Tag, Typography, message } from 'antd'
import type { DocumentSummary } from '@shared/ipcSchemas'

const statusLabels: Record<DocumentSummary['workflow']['status'], string> = {
  queued: '排队中', uploading: '上传中', parsing: '解析中', translating: '翻译中',
  partial: '部分完成', completed: '已完成', failed: '失败'
}

export default function TasksPage(props: { documents: DocumentSummary[]; onOpen(documentId: string): void }): React.JSX.Element {
  const [query, setQuery] = React.useState('')
  const [status, setStatus] = React.useState<DocumentSummary['workflow']['status'] | 'all'>('all')
  const [deleting, setDeleting] = React.useState<DocumentSummary | null>(null)
  const [deleteFiles, setDeleteFiles] = React.useState(false)
  const [messageApi, contextHolder] = message.useMessage()

  const filtered = React.useMemo(
    () => props.documents.filter((document) => document.displayName.toLowerCase().includes(query.toLowerCase()) && (status === 'all' || document.workflow.status === status)),
    [props.documents, query, status]
  )

  const remove = React.useCallback(async () => {
    if (!deleting) return
    try {
      await window.copilotix.deleteDocument({ documentId: deleting.id, deleteFiles })
      setDeleting(null)
      setDeleteFiles(false)
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
        pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (total) => `共 ${total} 项` }}
        onRow={(document) => ({ onDoubleClick: () => props.onOpen(document.id) })}
        columns={[
          {
            title: '任务名称', dataIndex: 'displayName', ellipsis: true,
            render: (name: string, document: DocumentSummary) => <button className="task-link" onClick={() => props.onOpen(document.id)}>{name}</button>
          },
          {
            title: '状态', width: 210,
            render: (_: unknown, document: DocumentSummary) => (
              <div className="task-status"><Tag color={statusColor(document.workflow.status)}>{statusLabels[document.workflow.status]}</Tag>{['queued', 'uploading', 'parsing', 'translating'].includes(document.workflow.status) ? <Progress percent={document.workflow.progress} size="small" showInfo={false} /> : null}</div>
            )
          },
          { title: '类型', width: 100, render: () => '文档' },
          { title: '创建时间', dataIndex: 'createdAt', width: 190, render: (value: string) => new Date(value).toLocaleString('zh-CN') },
          {
            title: '操作', width: 170,
            render: (_: unknown, document: DocumentSummary) => (
              <Space>
                <Button type="text" aria-label="打开输出目录" icon={<FolderOpenOutlined />} onClick={() => void window.copilotix.openDocumentOutput(document.id)} />
                {document.workflow.status === 'failed' || document.workflow.status === 'partial' ? <Button type="text" aria-label="重试" icon={<RedoOutlined />} onClick={() => void window.copilotix.retryDocument(document.id)} /> : null}
                <Button danger type="text" aria-label="删除" icon={<DeleteOutlined />} onClick={() => setDeleting(document)} />
              </Space>
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

function statusColor(status: DocumentSummary['workflow']['status']): string {
  if (status === 'completed') return 'success'
  if (status === 'failed') return 'error'
  if (status === 'partial') return 'warning'
  return 'processing'
}
