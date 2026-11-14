import React from 'react'
import { Checkbox, Modal, type message } from 'antd'
import type { DocumentSummary } from '../../contract/documentSchemas'

/** The reader's delete confirmation, opened from the sidebar's menu. */
export default function DeletePaperDialog(props: {
  paper: DocumentSummary | null
  messageApi: ReturnType<typeof message.useMessage>[0]
  onClose(): void
  onDeleted(documentId: string): void
}): React.JSX.Element {
  const { paper, messageApi, onClose, onDeleted } = props
  const [deleteFiles, setDeleteFiles] = React.useState(true)
  const [deleting, setDeleting] = React.useState(false)
  React.useEffect(() => { if (paper) setDeleteFiles(true) }, [paper])
  const remove = async (): Promise<void> => {
    if (!paper) return
    setDeleting(true)
    try {
      // Main settles this paper's chat before deleting it.
      await window.copilotix.deleteDocument({ documentId: paper.id, deleteFiles })
      messageApi.success('論文已刪除')
      onClose()
      onDeleted(paper.id)
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : String(error))
    } finally {
      setDeleting(false)
    }
  }
  return (
    <Modal title="刪除論文" open={paper !== null} okText="刪除" okButtonProps={{ danger: true }} confirmLoading={deleting}
      onOk={() => void remove()} onCancel={() => { if (!deleting) onClose() }}>
      <p>確定刪除“{paper?.displayName.replace(/\.pdf\s*$/iu, '')}”嗎？</p>
      <Checkbox checked={deleteFiles} onChange={(event) => setDeleteFiles(event.target.checked)}>同時刪除本地結果檔案（不可恢復）</Checkbox>
    </Modal>
  )
}
