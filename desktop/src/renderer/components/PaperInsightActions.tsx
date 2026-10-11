import React from 'react'
import { Button, Dropdown, type MenuProps } from 'antd'
import type { PaperInsightSource } from '@shared/paperInsight'
import { usePaperInsight } from '../usePaperInsight'

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
      : generating ? <>AI 正在阅读这篇论文…<Elapsed /></>
        : ready && 'brief' in ready ? `${ready.brief.provenance.model.name} · ${ready.stale ? '论文内容已更新' : ready.promptOutdated ? '可用新版提示词重新生成' : 'AI 档案卡'}`
          : ready ? '旧版解读可继续阅读，可升级为新版档案卡。' : state ? '尚未生成 AI 档案卡。' : '正在读取档案卡…'
  const items: MenuProps['items'] = [
    { key: 'status', disabled: true, label: <span className="reader-insight-status" role="status">{status}</span> },
    ...(state?.status === 'unavailable'
      ? [{ key: 'settings', label: '前往服务连接设置' }]
      : generating
        ? [{ key: 'cancel', label: '取消生成', disabled: !props.source.cancel }]
        : [{ key: 'generate', label: ready ? '重新生成档案卡' : '生成 AI 档案卡', disabled: !state }])
  ]
  return <Dropdown trigger={['click']} menu={{ items, onClick: ({ key }) => {
    if (key === 'generate') generate()
    else if (key === 'settings') props.onOpenSettings()
    else if (key === 'cancel') void props.source?.cancel?.(props.documentId).catch(() => undefined)
  } }}>
    <Button type="text" className="reader-insight-action" aria-label="档案卡">{generating ? '档案卡 · 生成中' : '档案卡'}</Button>
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
