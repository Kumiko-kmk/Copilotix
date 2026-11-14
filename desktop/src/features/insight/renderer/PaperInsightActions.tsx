import React from 'react'
import { Button, Dropdown, type MenuProps } from 'antd'
import type { PaperInsightSource } from '../contract/paperInsight'
import { usePaperInsight } from './usePaperInsight'

export default function PaperInsightActions(props: {
  documentId: string
  source?: PaperInsightSource
  onOpenSettings(): void
}): React.JSX.Element | null {
  const { state, ready, generate } = usePaperInsight(props.documentId, props.source)
  if (!props.source) return null
  const generating = state?.status === 'generating'
  const status = state?.status === 'unavailable' ? state.reason
    : state?.status === 'failed' ? state.error
      : generating ? <>AI 正在閱讀這篇論文…<Elapsed /></>
        : ready && 'brief' in ready ? `${ready.brief.provenance.model.name} · ${ready.stale ? '論文內容已更新' : ready.promptOutdated ? '可用新版提示詞重新生成' : 'AI 檔案卡'}`
          : ready ? '舊版解讀可繼續閱讀，可升級為新版檔案卡。' : state ? '尚未生成 AI 檔案卡。' : '正在讀取檔案卡…'
  const items: MenuProps['items'] = [
    { key: 'status', disabled: true, label: <span className="reader-insight-status" role="status">{status}</span> },
    ...(state?.status === 'unavailable'
      ? [{ key: 'settings', label: '前往服務連線設定' }]
      : generating
        ? [{ key: 'cancel', label: '取消生成', disabled: !props.source.cancel }]
        : [{ key: 'generate', label: ready ? '重新生成檔案卡' : '生成 AI 檔案卡', disabled: !state }])
  ]
  return <Dropdown trigger={['click']} menu={{ items, onClick: ({ key }) => {
    if (key === 'generate') generate()
    else if (key === 'settings') props.onOpenSettings()
    else if (key === 'cancel') void props.source?.cancel?.(props.documentId).catch(() => undefined)
  } }}>
    <Button type="text" className="reader-insight-action" aria-label="檔案卡">{generating ? '檔案卡 · 生成中' : '檔案卡'}</Button>
  </Dropdown>
}

function Elapsed(): React.JSX.Element {
  const [start] = React.useState(() => Date.now())
  const [now, setNow] = React.useState(start)
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const seconds = Math.floor((now - start) / 1000)
  return <span> {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</span>
}
