import React from 'react'
import type { message } from 'antd'
import { useQueryClient } from '@tanstack/react-query'
import { findTextLayerCandidates } from '@shared/textLayerRepair'

/** Layouts already tried in this session; lines the text layer cannot confirm are not retried on every open. */
const attempted = new Set<string>()

/**
 * Old papers are never re-parsed. When an opened paper still holds fragmented
 * lines (e.g. `d h f ld`), repair them once in the background from the PDF text
 * layer, without adding any control to the reader.
 */
export function useTextLayerRepair(documentId: string, layoutJson: string | undefined, messageApi: ReturnType<typeof message.useMessage>[0]): void {
  const queryClient = useQueryClient()
  React.useEffect(() => {
    if (!layoutJson) return
    const key = `${documentId}:${layoutJson.length}`
    if (attempted.has(key)) return
    let count = 0
    try { count = findTextLayerCandidates(JSON.parse(layoutJson)).length } catch { return }
    if (count === 0) return
    attempted.add(key)
    void window.copilotix.repairDocumentTextLayer(documentId).then(async (result) => {
      if (result.repaired === 0) return
      messageApi.success(`已用 PDF 文字层修复 ${result.repaired} 行解析乱码`)
      await queryClient.invalidateQueries({ queryKey: ['document', documentId] })
      await queryClient.invalidateQueries({ queryKey: ['annotations', documentId] })
    }).catch(() => {
      // Busy (parse/translation in flight) or unreadable PDF: try again on a later open.
      attempted.delete(key)
    })
  }, [documentId, layoutJson, messageApi, queryClient])
}
