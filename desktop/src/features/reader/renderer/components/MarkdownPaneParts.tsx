import React from 'react'
import { Alert, Button } from 'antd'
import AppleLoader from '@platform/ui/renderer/AppleLoader'
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
          <AppleLoader label="正在排版正文" />
          {props.mounted ? <small>段落 {props.mounted.count} / {props.mounted.total}</small> : null}
          {renderState.status === 'loading' && renderState.totalImages > 0 ? (
            <small>圖片 {renderState.completedImages} / {renderState.totalImages}</small>
          ) : null}
        </div>
      ) : null}
      {renderState.status === 'error' ? (
        <div className="markdown-render-status">
          <Alert
            type="error"
            showIcon
            message="Markdown 無法完整顯示"
            description={renderState.message}
            action={<Button onClick={props.onRetry}>重新載入</Button>}
          />
        </div>
      ) : null}
    </>
  )
}

/** The block context menu retains a way to reset an existing drag order. */
export function MarkdownBlockMenuPopup(props: {
  at: { block: ReaderBlock; figures: ReaderFigureGroup[]; x: number; y: number }
  menu: MarkdownBlockMenu
  blockMove?: ReaderBlockMove
  onClose(): void
}): React.JSX.Element {
  const { at: blockMenuAt } = props
  const moves: BlockMenuItem[] = [
    ...(props.blockMove?.ordered ? [{ key: 'reset-order', label: '恢復原始順序' }] : [])
  ]
  return <BlockContextMenu x={blockMenuAt.x} y={blockMenuAt.y} items={[...props.menu.items(blockMenuAt.block, blockMenuAt.figures), ...moves]}
    onSelect={(key) => {
      if (key === 'reset-order') props.blockMove?.reset()
      else props.menu.onSelect(key, blockMenuAt.block, blockMenuAt.figures)
    }} onClose={props.onClose} />
}
