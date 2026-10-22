import React from 'react'
import { ExportOutlined } from '@ant-design/icons'
import { Button, Modal, type message } from 'antd'
import type { ZoteroExportResult } from '@shared/zotero'

/**
 * Sends the paper to the running Zotero: a linked paper gets a note pointing at its Zotero item,
 * any other paper a new item with its PDF. A second export asks first, since Zotero keeps both.
 */
export default function ZoteroExportButton(props: {
  documentId: string
  messageApi: ReturnType<typeof message.useMessage>[0]
}): React.JSX.Element {
  const { documentId, messageApi } = props
  const [busy, setBusy] = React.useState(false)
  const [confirmRepeat, setConfirmRepeat] = React.useState(false)
  const run = async (repeat: boolean): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.copilotix.zotero.exportDocuments({ documentIds: [documentId], repeat })
      if (result.skipped.length > 0) setConfirmRepeat(true)
      else report(result)
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  const report = (result: ZoteroExportResult): void => {
    if (result.failed[0]) messageApi.error(result.failed[0].message)
    else if (result.notes > 0) messageApi.success('已在 Zotero 新建笔记，并链接到原条目')
    else if (result.items > 0) messageApi.success('已在 Zotero 新建条目，附 PDF 与笔记')
  }
  return <>
    <Button type="text" icon={<ExportOutlined />} loading={busy} onClick={() => void run(false)} aria-label="导出到 Zotero" />
    <Modal title="再次导出到 Zotero" open={confirmRepeat} okText="再次导出" confirmLoading={busy}
      onOk={() => { setConfirmRepeat(false); void run(true) }} onCancel={() => setConfirmRepeat(false)}>
      <p>这篇论文已经导出过。再次导出会在 Zotero 中再新建一份，旧的不会被替换。</p>
    </Modal>
  </>
}
