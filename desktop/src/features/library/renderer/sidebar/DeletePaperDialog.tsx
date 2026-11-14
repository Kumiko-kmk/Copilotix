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
      messageApi.success('论文已删除')
      onClose()
      onDeleted(paper.id)
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : String(error))
    } finally {
      setDeleting(false)
    }
  }
  return (
    <Modal title="删除论文" open={paper !== null} okText="删除" okButtonProps={{ danger: true }} confirmLoading={deleting}
      onOk={() => void remove()} onCancel={() => { if (!deleting) onClose() }}>
      <p>确定删除“{paper?.displayName.replace(/\.pdf\s*$/iu, '')}”吗？</p>
      <Checkbox checked={deleteFiles} onChange={(event) => setDeleteFiles(event.target.checked)}>同时删除本地结果文件（不可恢复）</Checkbox>
    </Modal>
  )
}
