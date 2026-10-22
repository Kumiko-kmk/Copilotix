import React from 'react'
import { Button, Modal, type message } from 'antd'
import { useQueryClient } from '@tanstack/react-query'
import { findTextLayerCandidates } from '@shared/textLayerRepair'

/**
 * Old papers are never re-parsed automatically. When the parse still holds
 * fragmented lines (e.g. `d h f ld`), offer a one-off repair from the PDF text layer.
 */
export default function TextLayerRepairAction(props: {
  documentId: string
  layoutJson: string
  messageApi: ReturnType<typeof message.useMessage>[0]
}): React.JSX.Element | null {
  const { documentId, layoutJson, messageApi } = props
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = React.useState(false)
  const [repairing, setRepairing] = React.useState(false)
  // Lines the text layer could not confirm stay as parsed; stop offering them again.
  const [checkedLayout, setCheckedLayout] = React.useState<string | null>(null)
  const count = React.useMemo(() => {
    try { return findTextLayerCandidates(JSON.parse(layoutJson)).length } catch { return 0 }
  }, [layoutJson])
  if (count === 0 || checkedLayout === layoutJson) return null
  const repair = async (): Promise<void> => {
    setRepairing(true)
    try {
      const result = await window.copilotix.repairDocumentTextLayer(documentId)
      setConfirming(false)
      setCheckedLayout(layoutJson)
      if (result.repaired > 0) {
        messageApi.success(result.unresolved > 0 ? `已修复 ${result.repaired} 行，另有 ${result.unresolved} 行无法用 PDF 文字层确认，保持原样` : `已修复 ${result.repaired} 行`)
        await queryClient.invalidateQueries({ queryKey: ['document', documentId] })
        await queryClient.invalidateQueries({ queryKey: ['annotations', documentId] })
      } else {
        messageApi.info('PDF 文字层无法确认这些行，保持原样')
      }
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : String(error))
    } finally {
      setRepairing(false)
    }
  }
  return <>
    <Button type="text" className="reader-text-layer-action" onClick={() => setConfirming(true)}>修复乱码（{count} 行）</Button>
    <Modal title="用 PDF 文字层修复乱码" open={confirming} okText="修复" confirmLoading={repairing}
      onOk={() => void repair()} onCancel={() => { if (!repairing) setConfirming(false) }}>
      <p>解析结果中有 {count} 行只剩零散字母（例如“d h f ld”）。修复会按页码和位置读取 PDF 自身的文字，仅在能确认时替换这些行；公式、表格和无文字层的扫描页保持原样。</p>
      <p>原文标注会保留并重新定位。这些段落的现有译文仍基于修复前的文字，需重新翻译才会更新；图片 AI 解读与档案卡会显示“论文内容已更新”。</p>
    </Modal>
  </>
}
