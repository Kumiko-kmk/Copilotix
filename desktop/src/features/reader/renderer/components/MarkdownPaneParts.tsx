import React from 'react'
import { Alert, Button, Spin } from 'antd'
import type { ReaderBlock } from '../../core/readerDocument'
import type { ReaderFigureGroup } from '../../core/readerFigureGroups'
import BlockContextMenu, { type BlockMenuItem } from './BlockContextMenu'
import type { ReaderBlockMove } from './ReaderBlockReorder'

export type RenderState =
  | { status: 'loading'; completedImages: number; totalImages: number }
  | { status: 'preparing' }
  | { status: 'ready' }
  | { status: 'error'; message: string }

export interface MarkdownBlockMenu {
  items(block: ReaderBlock, figures: ReaderFigureGroup[]): BlockMenuItem[]
  onSelect(key: string, block: ReaderBlock, figures: ReaderFigureGroup[]): void
}

/** Loading progress or the render error of a Markdown view; nothing once it renders (or renders progressively). */
export function MarkdownRenderStatus(props: {
  state: RenderState
  progressive: boolean
  /** Paragraphs mounted so far, while the progressive mount is still running. */
  mounted: { count: number; total: number } | null
  onRetry(): void
}): React.JSX.Element {
  const renderState = props.state
  return (
    <>
      {(renderState.status === 'loading' || renderState.status === 'preparing') && !props.progressive ? (
        <div className="markdown-render-status" role="status">
          <Spin size="large" />
          <span>正在渲染 Markdown…</span>
          {props.mounted ? <small>段落 {props.mounted.count} / {props.mounted.total}</small> : null}
          {renderState.status === 'loading' && renderState.totalImages > 0 ? (
            <small>图片 {renderState.completedImages} / {renderState.totalImages}</small>
          ) : null}
        </div>
      ) : null}
      {renderState.status === 'error' ? (
        <div className="markdown-render-status">
          <Alert
            type="error"
            showIcon
            message="Markdown 无法完整显示"
            description={renderState.message}
            action={<Button onClick={props.onRetry}>重新加载</Button>}
          />
        </div>
      ) : null}
    </>
  )
}

/** The block context menu of a Markdown view, with move up / move down / original order when blocks can be reordered. */
export function MarkdownBlockMenuPopup(props: {
  at: { block: ReaderBlock; figures: ReaderFigureGroup[]; x: number; y: number }
  menu: MarkdownBlockMenu
  blockMove?: ReaderBlockMove
  neighbours: { unit: number[]; up?: number; down?: number | null } | null
  contentIndexOf(index: number): number | undefined
  onClose(): void
}): React.JSX.Element {
  const { at: blockMenuAt, neighbours, contentIndexOf } = props
  const units = (neighbours?.unit ?? []).flatMap(index => { const content = contentIndexOf(index); return content === undefined ? [] : [content] })
  const moves: BlockMenuItem[] = [
    ...(neighbours?.up !== undefined ? [{ key: 'move-up', label: '上移' }] : []),
    ...(neighbours?.down !== undefined ? [{ key: 'move-down', label: '下移' }] : []),
    ...(props.blockMove?.ordered ? [{ key: 'reset-order', label: '恢复原始顺序' }] : [])
  ]
  return <BlockContextMenu x={blockMenuAt.x} y={blockMenuAt.y} items={[...props.menu.items(blockMenuAt.block, blockMenuAt.figures), ...moves]}
    onSelect={(key) => {
      if (key === 'move-up' && neighbours?.up !== undefined) props.blockMove?.move(units, neighbours.up)
      else if (key === 'move-down' && neighbours?.down !== undefined) props.blockMove?.move(units, neighbours.down)
      else if (key === 'reset-order') props.blockMove?.reset()
      else props.menu.onSelect(key, blockMenuAt.block, blockMenuAt.figures)
    }} onClose={props.onClose} />
}
