import React from 'react'
import { BorderOutlined, ColumnWidthOutlined, LeftOutlined, MinusOutlined, PlusOutlined, RightOutlined } from '@ant-design/icons'
import { Button, Space } from 'antd'

export function PdfControls(props: {
  page: number
  pages: number
  zoom: number
  showBounds: boolean
  onPage(page: number): void
  onZoom(zoom: number): void
  onToggleBounds(): void
}): React.JSX.Element {
  const [draft, setDraft] = React.useState<string | null>(null)
  const commit = (): void => {
    const page = Number(draft)
    if (draft?.trim() && Number.isInteger(page)) props.onPage(page)
    setDraft(null)
  }
  return <Space size={2}>
    <Button disabled={!props.pages || props.page <= 1} type="text" icon={<LeftOutlined />} onClick={() => props.onPage(props.page - 1)} aria-label="上一页" />
    {draft === null
      ? <Button type="text" disabled={!props.pages} aria-label="跳转到页" onClick={() => setDraft(String(props.page))}>{props.page} / {props.pages || '-'}</Button>
      : <input className="pdf-page-input" aria-label="PDF 页码" inputMode="numeric" autoFocus value={draft}
          onChange={(event) => setDraft(event.target.value)} onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') { event.preventDefault(); commit() }
            if (event.key === 'Escape') { event.preventDefault(); setDraft(null) }
          }} />}
    <Button disabled={!props.pages || props.page >= props.pages} type="text" icon={<RightOutlined />} onClick={() => props.onPage(props.page + 1)} aria-label="下一页" />
    <Button disabled={!props.pages || props.zoom <= 0.6} type="text" icon={<MinusOutlined />} onClick={() => props.onZoom(Math.max(0.6, props.zoom - 0.1))} aria-label="缩小" />
    <span>{Math.round(props.zoom * 100)}%</span>
    <Button disabled={!props.pages || props.zoom >= 2} type="text" icon={<PlusOutlined />} onClick={() => props.onZoom(Math.min(2, props.zoom + 0.1))} aria-label="放大" />
    <Button disabled={!props.pages} type="text" icon={<ColumnWidthOutlined />} aria-label="适合宽度" onClick={() => props.onZoom(1)} />
    <Button type="text" icon={<BorderOutlined />} aria-label="显示区块边框" aria-pressed={props.showBounds} onClick={props.onToggleBounds} />
  </Space>
}
