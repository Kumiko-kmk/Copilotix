import React from 'react'
import { DeleteOutlined, RedoOutlined } from '@ant-design/icons'
import { Button, Checkbox, Modal, type message } from 'antd'
import type { DocumentSummary } from '@shared/ipcSchemas'
import { canRetry } from '../documentStatus'

/** Retry and delete, which used to live in the task list: retry only while it can help, delete after confirmation. */
export default function DocumentLifecycleActions(props: {
  summary: DocumentSummary
  messageApi: ReturnType<typeof message.useMessage>[0]
  onDeleted(): void
}): React.JSX.Element {
  const { summary, messageApi, onDeleted } = props
  const [confirming, setConfirming] = React.useState(false)
  const [deleteFiles, setDeleteFiles] = React.useState(true)
  const [deleting, setDeleting] = React.useState(false)
  const retry = async (): Promise<void> => {
    try {
      await window.copilotix.retryDocument(summary.id)
      messageApi.success('已重新排队，将保留已完成的译文')
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : String(error))
    }
  }
  const remove = async (): Promise<void> => {
    setDeleting(true)
    try {
      // Main settles this paper's chat before deleting; the reader leaves afterwards.
      await window.copilotix.deleteDocument({ documentId: summary.id, deleteFiles })
      setConfirming(false)
      messageApi.success('论文已删除')
      onDeleted()
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : String(error))
    } finally {
      setDeleting(false)
    }
  }
  return <>
    {canRetry(summary.workflow.status) ? <Button type="text" icon={<RedoOutlined />} onClick={() => void retry()} aria-label="重试" /> : null}
    <Button type="text" danger icon={<DeleteOutlined />} onClick={() => { setDeleteFiles(true); setConfirming(true) }} aria-label="删除论文" />
    <Modal title="删除论文" open={confirming} okText="删除" okButtonProps={{ danger: true }} confirmLoading={deleting}
      onOk={() => void remove()} onCancel={() => { if (!deleting) setConfirming(false) }}>
      <p>确定从文库删除“{summary.displayName}”吗？</p>
      <Checkbox checked={deleteFiles} onChange={(event) => setDeleteFiles(event.target.checked)}>同时删除本地结果文件（不可恢复）</Checkbox>
    </Modal>
  </>
}
