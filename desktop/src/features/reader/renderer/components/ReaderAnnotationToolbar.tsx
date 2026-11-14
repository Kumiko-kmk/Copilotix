import React from 'react'
import { HighlightOutlined, MessageOutlined, UnderlineOutlined } from '@ant-design/icons'
import type { HighlightColor } from '../../contract/readerTypes'
import { READER_HIGHLIGHT_COLORS } from '../../core/readerAnnotations'
import type { ReaderTextSelection } from '../readerAnnotations'
import { QuillIcon } from './ReaderNotes'

const HIGHLIGHT_COLOR_VALUES: Record<HighlightColor, string> = {
  yellow: '#F4C542',
  green: '#67C587',
  blue: '#64A8E8',
  pink: '#E98AB4',
  purple: '#A98BEA'
}

export default function ReaderAnnotationToolbar(props: {
  selection: ReaderTextSelection
  color: HighlightColor
  paletteOpen: boolean
  onPaletteOpen(): void
  onPaletteClose(): void
  onPaletteHover(): void
  onPaletteHoverEnd(): void
  onColorChange(color: HighlightColor): void
  onHighlight(): void
  onUnderline(): void
  onAddToChat?(): void
  onNote?(): void
}): React.JSX.Element {
  const above = props.selection.rect.top >= 92
  const center = props.selection.rect.left + props.selection.rect.width / 2
  const left = Math.max(68, Math.min(window.innerWidth - 68, center))
  const top = above ? props.selection.rect.top - 10 : props.selection.rect.bottom + 10
  return (
    <div
      className={`reader-annotation-toolbar ${above ? 'above' : 'below'}`}
      data-testid="reader-annotation-toolbar"
      style={{ left, top }}
      onMouseDown={(event) => event.preventDefault()}
      role="toolbar"
      aria-label="文本标注"
    >
      {props.paletteOpen ? (
        <div className="reader-highlight-palette" role="listbox" aria-label="荧光笔颜色">
          {READER_HIGHLIGHT_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              className={color === props.color ? 'active' : ''}
              style={{ '--highlight-swatch': HIGHLIGHT_COLOR_VALUES[color] } as React.CSSProperties}
              aria-label={`选择${highlightColorLabel(color)}`}
              aria-selected={color === props.color}
              role="option"
              onClick={() => {
                props.onColorChange(color)
                props.onPaletteClose()
              }}
            />
          ))}
        </div>
      ) : null}
      <button
        type="button"
        aria-label="荧光笔高亮"
        onClick={props.onHighlight}
        onMouseEnter={props.onPaletteHover}
        onMouseLeave={props.onPaletteHoverEnd}
        onContextMenu={(event) => {
          event.preventDefault()
          props.onPaletteOpen()
        }}
      >
        <HighlightOutlined style={{ color: HIGHLIGHT_COLOR_VALUES[props.color] }} />
      </button>
      <button type="button" aria-label="添加下划线" onClick={props.onUnderline}>
        <UnderlineOutlined />
      </button>
      {props.onNote ? (
        <button type="button" aria-label="写笔记" onClick={props.onNote}>
          <QuillIcon />
        </button>
      ) : null}
      {props.onAddToChat ? <button type="button" aria-label="添加到对话" onClick={props.onAddToChat}>
        <MessageOutlined />
      </button> : null}
    </div>
  )
}

function highlightColorLabel(color: HighlightColor): string {
  return ({ yellow: '黄色', green: '绿色', blue: '蓝色', pink: '粉色', purple: '紫色' })[color]
}
