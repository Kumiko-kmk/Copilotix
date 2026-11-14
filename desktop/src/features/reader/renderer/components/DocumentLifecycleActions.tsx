import React from 'react'
import { DeleteOutlined, RedoOutlined } from '@ant-design/icons'
import { Button, Checkbox, Modal, type message } from 'antd'
import type { DocumentSummary } from '@features/library/contract/documentSchemas'
import { canRetry } from '@features/library/renderer'

/** Retry and delete, which used to live in the task list: retry only while it can help, delete after confirmation. */
export default function DocumentLifecycleActions(props: {
  summary: DocumentSummary
  /** Some translated paragraphs predate a repair of their original text. */
  staleTranslation?: boolean
  messageApi: ReturnType<typeof message.useMessage>[0]
  onDeleted(): void
}): React.JSX.Element {
  const { summary, staleTranslation, messageApi, onDeleted } = props
  const [confirming, setConfirming] = React.useState(false)
  const [deleteFiles, setDeleteFiles] = React.useState(true)
  const [deleting, setDeleting] = React.useState(false)
  const retry = async (): Promise<void> => {
    try {
      await window.copilotix.retryDocument(summary.id)
      messageApi.success('已重新排隊，將保留已完成的譯文')
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
      messageApi.success('論文已刪除')
      onDeleted()
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : String(error))
    } finally {
      setDeleting(false)
    }
  }
  return <>
    {canRetry(summary.workflow.status) || staleTranslation ? <Button type="text" icon={<RedoOutlined />} onClick={() => void retry()} aria-label="重試" /> : null}
    <Button type="text" danger icon={<DeleteOutlined />} onClick={() => { setDeleteFiles(true); setConfirming(true) }} aria-label="刪除論文" />
    <Modal title="刪除論文" open={confirming} okText="刪除" okButtonProps={{ danger: true }} confirmLoading={deleting}
      onOk={() => void remove()} onCancel={() => { if (!deleting) setConfirming(false) }}>
      <p>確定刪除“{summary.displayName}”嗎？</p>
      <Checkbox checked={deleteFiles} onChange={(event) => setDeleteFiles(event.target.checked)}>同時刪除本地結果檔案（不可恢復）</Checkbox>
    </Modal>
  </>
}
