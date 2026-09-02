import React from 'react'
import { Empty, Input, Segmented, Tag } from 'antd'
import type { ReaderBlock } from '@shared/readerDocument'
import type {
  BlockSelection,
  HighlightColor,
  ReaderAnnotation,
  ReaderAnnotationView,
  ReaderChatSelection,
} from '@shared/types'
import type { DocumentWorkflowStatus } from '@shared/ipcSchemas'
import JsonPane from './JsonPane'
import MarkdownPane from './MarkdownPane'

export type ReaderTab = 'original' | 'translated' | 'json'

export default function ReaderTextPane(props: {
  tab: ReaderTab
  onTabChange(tab: ReaderTab): void
  originalBlocks: ReaderBlock[]
  translatedBlocks: ReaderBlock[]
  translatedReady: boolean
  taskStatus: DocumentWorkflowStatus
  layoutJson: string
  jsonQuery: string
  onJsonQueryChange(query: string): void
  assetBaseUrl: string
  taskId: string
  annotations: ReaderAnnotation[]
  onReplaceAnnotations(view: ReaderAnnotationView, annotations: ReaderAnnotation[]): Promise<void>
  onAddToChat?(selection: ReaderChatSelection): void
  selection: BlockSelection | null
  onSelect(selection: BlockSelection): void
}): React.JSX.Element {
  const [prewarmStage, setPrewarmStage] = React.useState<0 | 1 | 2>(0)
  const [highlightColor, setHighlightColor] = React.useState<HighlightColor>('yellow')
  const originalAnnotations = React.useMemo(
    () => props.annotations.filter((annotation) => annotation.view === 'original'),
    [props.annotations]
  )
  const translatedAnnotations = React.useMemo(
    () => props.annotations.filter((annotation) => annotation.view === 'translated'),
    [props.annotations]
  )
  const replaceOriginalAnnotations = React.useCallback(
    (annotations: ReaderAnnotation[]) => props.onReplaceAnnotations('original', annotations),
    [props.onReplaceAnnotations]
  )
  const replaceTranslatedAnnotations = React.useCallback(
    (annotations: ReaderAnnotation[]) => props.onReplaceAnnotations('translated', annotations),
    [props.onReplaceAnnotations]
  )

  React.useEffect(() => scheduleIdle(() => setPrewarmStage(1)), [])
  React.useEffect(() => {
    if (prewarmStage !== 1) return
    return scheduleIdle(() => setPrewarmStage(2))
  }, [prewarmStage])

  const mountTranslated = props.translatedReady && (prewarmStage >= 1 || props.tab === 'translated')
  const mountJson = prewarmStage >= 2 || props.tab === 'json'

  return (
    <div className="text-pane">
      <div className="text-toolbar">
        <Segmented<ReaderTab>
          value={props.tab}
          onChange={props.onTabChange}
          options={[
            { value: 'original', label: 'Markdown' },
            { value: 'translated', label: 'Markdown（中文）' },
            { value: 'json', label: 'JSON' }
          ]}
        />
        {props.tab === 'translated' ? (
          <Tag color={translationColor(props.taskStatus)}>{translationLabel(props.taskStatus)}</Tag>
        ) : null}
        {props.tab === 'json' ? (
          <Input
            allowClear
            size="small"
            placeholder="搜索 JSON"
            value={props.jsonQuery}
            onChange={(event) => props.onJsonQueryChange(event.target.value)}
          />
        ) : null}
      </div>
      <ReaderPanel tab="original" activeTab={props.tab}>
        <MarkdownPane
          active={props.tab === 'original'}
          blocks={props.originalBlocks}
          assetBaseUrl={props.assetBaseUrl}
          taskId={props.taskId}
          view="original"
          annotations={originalAnnotations}
          highlightColor={highlightColor}
          onHighlightColorChange={setHighlightColor}
          onReplaceAnnotations={replaceOriginalAnnotations}
          onAddToChat={props.onAddToChat}
          selection={props.selection}
          onSelect={props.onSelect}
        />
      </ReaderPanel>
      <ReaderPanel tab="translated" activeTab={props.tab}>
        {mountTranslated ? (
          <MarkdownPane
            active={props.tab === 'translated'}
            blocks={props.translatedBlocks}
            assetBaseUrl={props.assetBaseUrl}
            taskId={props.taskId}
            view="translated"
            annotations={translatedAnnotations}
            highlightColor={highlightColor}
            onHighlightColorChange={setHighlightColor}
            onReplaceAnnotations={replaceTranslatedAnnotations}
            onAddToChat={props.onAddToChat}
            selection={props.selection}
            onSelect={props.onSelect}
          />
        ) : props.translatedReady ? null : (
          <Empty className="translation-empty" description={translationLabel(props.taskStatus)} />
        )}
      </ReaderPanel>
      <ReaderPanel tab="json" activeTab={props.tab}>
        {mountJson ? <JsonPane json={props.layoutJson} query={props.jsonQuery} active={props.tab === 'json'} /> : null}
      </ReaderPanel>
    </div>
  )
}

function ReaderPanel(props: {
  tab: ReaderTab
  activeTab: ReaderTab
  children: React.ReactNode
}): React.JSX.Element {
  const active = props.tab === props.activeTab
  return (
    <div
      className={'reader-tab-panel ' + (active ? 'active' : 'inactive')}
      data-reader-tab-panel={props.tab}
      aria-hidden={!active}
    >
      {props.children}
    </div>
  )
}

function scheduleIdle(callback: () => void): () => void {
  const idleWindow = window as Window & {
    requestIdleCallback?: (handler: () => void, options?: { timeout: number }) => number
    cancelIdleCallback?: (id: number) => void
  }
  if (typeof idleWindow.requestIdleCallback === 'function') {
    const id = idleWindow.requestIdleCallback(callback, { timeout: 500 })
    return () => idleWindow.cancelIdleCallback?.(id)
  }
  const id = globalThis.setTimeout(callback, 0)
  return () => globalThis.clearTimeout(id)
}

function translationLabel(status: DocumentWorkflowStatus): string {
  if (status === 'completed') return '翻译完成'
  if (status === 'partial') return '部分翻译完成，可重试失败区块'
  if (status === 'failed') return '任务失败'
  if (status === 'translating') return '正在翻译'
  return '等待解析完成'
}

function translationColor(status: DocumentWorkflowStatus): string {
  if (status === 'completed') return 'success'
  if (status === 'partial') return 'warning'
  if (status === 'failed') return 'error'
  return 'processing'
}
