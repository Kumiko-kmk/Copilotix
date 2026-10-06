import React from 'react'
import { Badge, Empty, Input, Segmented, Tag } from 'antd'
import type { ReaderBlock } from '@shared/readerDocument'
import type {
  BlockMapping,
  BlockSelection,
  HighlightColor,
  ReaderAnnotation,
  ReaderAnnotationView,
  ReaderChatSelection,
} from '@shared/types'
import type { DocumentWorkflowStatus } from '@shared/ipcSchemas'
import JsonPane from './JsonPane'
import MarkdownPane from './MarkdownPane'
import ReaderChatPanel, { ReaderChatToolbar } from './ReaderChatPanel'
import type { PaperChatController } from '../usePaperChat'
import { buildReaderFigureGeometries, projectReaderFigureGroups } from '../readerFigureGroups'

export type ReaderTab = 'original' | 'translated' | 'json' | 'chat'

/** AI chat lives in the same frame as the readers; it is optional so the reader works without it. */
export interface ReaderChatOptions {
  controller: PaperChatController
  onOpenSettings(): void
  onCitation(selection: BlockSelection): void
}

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
  pdfUrl?: string
  mappings?: BlockMapping[]
  taskId: string
  annotations: ReaderAnnotation[]
  onReplaceAnnotations(view: ReaderAnnotationView, annotations: ReaderAnnotation[]): Promise<void>
  onAddToChat?(selection: ReaderChatSelection): void
  selection: BlockSelection | null
  onSelect(selection: BlockSelection): void
  chat?: ReaderChatOptions
}): React.JSX.Element {
  const [highlightColor, setHighlightColor] = React.useState<HighlightColor>('yellow')
  const scrollPositionsRef = React.useRef<Record<ReaderAnnotationView, number>>({ original: 0, translated: 0 })
  const originalAnnotations = React.useMemo(
    () => props.annotations.filter((annotation) => annotation.view === 'original'),
    [props.annotations]
  )
  const translatedAnnotations = React.useMemo(
    () => props.annotations.filter((annotation) => annotation.view === 'translated'),
    [props.annotations]
  )
  const figureGeometries = React.useMemo(
    () => buildReaderFigureGeometries(props.mappings ?? []),
    [props.mappings]
  )
  const originalFigureGroups = React.useMemo(
    () => projectReaderFigureGroups(figureGeometries, props.originalBlocks),
    [figureGeometries, props.originalBlocks]
  )
  const translatedFigureGroups = React.useMemo(
    () => projectReaderFigureGroups(figureGeometries, props.translatedBlocks),
    [figureGeometries, props.translatedBlocks]
  )
  const replaceOriginalAnnotations = React.useCallback(
    (annotations: ReaderAnnotation[]) => props.onReplaceAnnotations('original', annotations),
    [props.onReplaceAnnotations]
  )
  const replaceTranslatedAnnotations = React.useCallback(
    (annotations: ReaderAnnotation[]) => props.onReplaceAnnotations('translated', annotations),
    [props.onReplaceAnnotations]
  )

  const rememberOriginalScroll = React.useCallback((scrollTop: number) => {
    scrollPositionsRef.current.original = scrollTop
  }, [])
  const rememberTranslatedScroll = React.useCallback((scrollTop: number) => {
    scrollPositionsRef.current.translated = scrollTop
  }, [])

  return (
    <div className="text-pane">
      <div className="text-toolbar">
        <Segmented<ReaderTab>
          value={props.tab}
          onChange={props.onTabChange}
          options={[
            { value: 'original', label: 'Markdown' },
            { value: 'translated', label: 'Markdown（中文）' },
            { value: 'json', label: 'JSON' },
            ...(props.chat ? [{ value: 'chat' as const, label: <ChatTabLabel controller={props.chat.controller} /> }] : [])
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
        {props.tab === 'chat' && props.chat ? <ReaderChatToolbar chat={props.chat.controller} /> : null}
      </div>
      <ReaderPanel tab="original" activeTab={props.tab}>
        {props.tab === 'original' ? <MarkdownPane
          active={props.tab === 'original'}
          blocks={props.originalBlocks}
          assetBaseUrl={props.assetBaseUrl}
          pdfUrl={props.pdfUrl}
          figureGroups={originalFigureGroups}
          taskId={props.taskId}
          view="original"
          annotations={originalAnnotations}
          highlightColor={highlightColor}
          onHighlightColorChange={setHighlightColor}
          onReplaceAnnotations={replaceOriginalAnnotations}
          onAddToChat={props.onAddToChat}
          selection={props.selection}
          onSelect={props.onSelect}
          initialScrollTop={scrollPositionsRef.current.original}
          onScrollTopChange={rememberOriginalScroll}
        /> : null}
      </ReaderPanel>
      <ReaderPanel tab="translated" activeTab={props.tab}>
        {props.translatedReady && props.tab === 'translated' ? (
          <MarkdownPane
            active={props.tab === 'translated'}
            blocks={props.translatedBlocks}
            assetBaseUrl={props.assetBaseUrl}
            pdfUrl={props.pdfUrl}
            figureGroups={translatedFigureGroups}
            taskId={props.taskId}
            view="translated"
            annotations={translatedAnnotations}
            highlightColor={highlightColor}
            onHighlightColorChange={setHighlightColor}
            onReplaceAnnotations={replaceTranslatedAnnotations}
            onAddToChat={props.onAddToChat}
            selection={props.selection}
            onSelect={props.onSelect}
            initialScrollTop={scrollPositionsRef.current.translated}
            onScrollTopChange={rememberTranslatedScroll}
          />
        ) : props.translatedReady ? null : (
          <Empty className="translation-empty" description={translationLabel(props.taskStatus)} />
        )}
      </ReaderPanel>
      <ReaderPanel tab="json" activeTab={props.tab}>
        {props.tab === 'json' ? <JsonPane json={props.layoutJson} query={props.jsonQuery} active /> : null}
      </ReaderPanel>
      {props.chat ? (
        // Stays mounted while hidden so scroll position and streaming output survive tab switches.
        <ReaderPanel tab="chat" activeTab={props.tab}>
          <ReaderChatPanel
            documentId={props.taskId}
            chat={props.chat.controller}
            active={props.tab === 'chat'}
            onSelect={props.chat.onCitation}
            onOpenSettings={props.chat.onOpenSettings}
          />
        </ReaderPanel>
      ) : null}
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

function ChatTabLabel(props: { controller: PaperChatController }): React.JSX.Element {
  const pinned = props.controller.pinned.length
  return (
    <span className="reader-chat-tab">
      AI 问答
      {props.controller.busy ? <span className="reader-chat-tab-busy" aria-label="正在生成" /> : null}
      {pinned > 0 ? <Badge count={pinned} size="small" color="var(--primary)" title={`${pinned} 个选区`} /> : null}
    </span>
  )
}

function translationLabel(status: DocumentWorkflowStatus): string {
  if (status === 'completed') return '翻译完成'
  if (status === 'partial') return '部分翻译完成，可重试失败区块'
  if (status === 'failed') return '任务失败'
  if (status === 'translating') return '正在翻译'
  if (status === 'queued') return '等待翻译，当前可阅读原文'
  return '等待解析完成'
}

function translationColor(status: DocumentWorkflowStatus): string {
  if (status === 'completed') return 'success'
  if (status === 'partial') return 'warning'
  if (status === 'failed') return 'error'
  return 'processing'
}
