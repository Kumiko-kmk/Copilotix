import React from 'react'
import { createPortal } from 'react-dom'
import { Badge, Button, Tag } from 'antd'
import { FilePdfOutlined, FileTextOutlined, MessageOutlined, TranslationOutlined } from '@ant-design/icons'
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
import type { PaperInsightSource } from '@shared/paperInsight'
import MarkdownPane from './MarkdownPane'
import PdfPane, { type PdfViewState } from './PdfPane'
import ReaderChatPanel, { ReaderChatToolbar } from './ReaderChatPanel'
import PaperInsightActions from './PaperInsightActions'
import type { PaperChatController } from '../usePaperChat'
import type { ReaderViewId } from '../readerLayout'
import { buildReaderFigureGeometries, projectReaderFigureGroups } from '@shared/readerFigureGroups'
import { createScrollSyncHub } from '../readerScrollSync'
import { useFigureArtifacts } from '../useFigureArtifacts'
import { canRetry } from '../documentStatus'

/** AI chat lives in the same workbench as the readers; it is optional so the reader works without it. */
export interface ReaderChatOptions {
  controller: PaperChatController
  insights?: PaperInsightSource
  onOpenSettings(): void
  onCitation(selection: BlockSelection): void
}

export interface ReaderViewContext {
  /** True while this view is the selected tab of its group. */
  active: boolean
  /** The group's tab-bar slot for view-specific controls; null while inactive. */
  actionsHost: HTMLElement | null
}

export interface ReaderViewSpec {
  /** Plain label, used for tabs, menus and accessible names. */
  label: string
  icon: React.ReactNode
  /** Optional rich tab content (badges, status dots); defaults to the label. */
  tab?: React.ReactNode
  /**
   * Heavy readers mount only while selected. Views that keep state worth
   * preserving (PDF position, chat stream) stay mounted once first shown.
   */
  keepMounted?: boolean
  /** Extra class for the view panel; Markdown and chat keep the legacy tab-panel class. */
  panelClassName?: string
  render(context: ReaderViewContext): React.ReactNode
}

export type ReaderViewSpecs = Partial<Record<ReaderViewId, ReaderViewSpec>>

export interface ReaderViewsInput {
  pdfUrl?: string
  mappings?: BlockMapping[]
  layoutJson?: string
  originalBlocks: ReaderBlock[]
  translatedBlocks: ReaderBlock[]
  translatedReady: boolean
  taskStatus: DocumentWorkflowStatus
  taskError?: string | null
  onRetry?(): Promise<void>
  assetBaseUrl: string
  taskId: string
  annotations: ReaderAnnotation[]
  onReplaceAnnotations(view: ReaderAnnotationView, annotations: ReaderAnnotation[]): Promise<void>
  onAddToChat?(selection: ReaderChatSelection): void
  selection: BlockSelection | null
  onSelect(selection: BlockSelection): void
  onOpenFigurePdf?(selection: BlockSelection): void
  chat?: ReaderChatOptions
  /** Reading views currently on screen with scroll sync on; they lead and follow each other. */
  scrollSyncViews?: readonly ReaderViewId[]
}

/**
 * Builds the workbench views for one paper. Scroll positions and the PDF
 * reading position live here, outside the panes, so a view that is moved to
 * another group or reopened resumes where it was.
 */
export function useReaderViews(props: ReaderViewsInput): ReaderViewSpecs {
  const [highlightColor, setHighlightColor] = React.useState<HighlightColor>('yellow')
  const scrollPositionsRef = React.useRef<Record<ReaderAnnotationView, number>>({ original: 0, translated: 0 })
  const pdfStateRef = React.useRef<PdfViewState | null>(null)
  const syncHub = React.useMemo(createScrollSyncHub, [])
  React.useEffect(() => () => syncHub.dispose(), [syncHub])
  const syncKey = (props.scrollSyncViews ?? []).join(',')
  React.useEffect(() => {
    syncHub.setParticipants(syncKey ? syncKey.split(',') as ReaderViewId[] : [])
  }, [syncHub, syncKey])
  const mappings = props.mappings ?? EMPTY_MAPPINGS
  const originalAnnotations = React.useMemo(
    () => props.annotations.filter((annotation) => annotation.view === 'original'),
    [props.annotations]
  )
  const translatedAnnotations = React.useMemo(
    () => props.annotations.filter((annotation) => annotation.view === 'translated'),
    [props.annotations]
  )
  const figureGeometries = React.useMemo(() => buildReaderFigureGeometries(mappings, props.layoutJson), [mappings, props.layoutJson])
  useFigureArtifacts(props.taskId, props.pdfUrl, figureGeometries)
  const originalFigureGroups = React.useMemo(
    () => projectReaderFigureGroups(figureGeometries, props.originalBlocks),
    [figureGeometries, props.originalBlocks]
  )
  const translatedFigureGroups = React.useMemo(
    () => projectReaderFigureGroups(figureGeometries, props.translatedBlocks, props.originalBlocks),
    [figureGeometries, props.translatedBlocks, props.originalBlocks]
  )
  const { onReplaceAnnotations } = props
  const replaceOriginalAnnotations = React.useCallback(
    (annotations: ReaderAnnotation[]) => onReplaceAnnotations('original', annotations),
    [onReplaceAnnotations]
  )
  const replaceTranslatedAnnotations = React.useCallback(
    (annotations: ReaderAnnotation[]) => onReplaceAnnotations('translated', annotations),
    [onReplaceAnnotations]
  )
  const rememberOriginalScroll = React.useCallback((scrollTop: number) => {
    scrollPositionsRef.current.original = scrollTop
  }, [])
  const rememberTranslatedScroll = React.useCallback((scrollTop: number) => {
    scrollPositionsRef.current.translated = scrollTop
  }, [])
  const rememberPdfState = React.useCallback((state: PdfViewState) => {
    pdfStateRef.current = state
  }, [])

  return React.useMemo<ReaderViewSpecs>(() => {
    const specs: ReaderViewSpecs = {
      original: {
        label: '原文',
        icon: <FileTextOutlined />,
        panelClassName: 'reader-tab-panel',
        render: ({ active }) => !props.originalBlocks.some(block => block.role === 'content' && block.markdown.trim()) ? <ReaderDocumentState view="original" status={props.taskStatus} error={props.taskError} onRetry={props.onRetry} /> : active ? <MarkdownPane
          active
          blocks={props.originalBlocks}
          assetBaseUrl={props.assetBaseUrl}
          pdfUrl={props.pdfUrl}
          figureGroups={originalFigureGroups}
          onOpenFigurePdf={props.onOpenFigurePdf}
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
          scrollSync={syncHub.channel('original')}
        /> : null
      },
      translated: {
        label: '译文',
        icon: <TranslationOutlined />,
        panelClassName: 'reader-tab-panel',
        render: ({ active, actionsHost }) => <>
          {actionsHost ? createPortal(<Tag color={translationColor(props.taskStatus)}>{translationLabel(props.taskStatus)}</Tag>, actionsHost) : null}
          {props.translatedReady ? (active ? <MarkdownPane
            active
            blocks={props.translatedBlocks}
            assetBaseUrl={props.assetBaseUrl}
            pdfUrl={props.pdfUrl}
            figureGroups={translatedFigureGroups}
            onOpenFigurePdf={props.onOpenFigurePdf}
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
            scrollSync={syncHub.channel('translated')}
          /> : null) : <ReaderDocumentState view="translated" status={props.taskStatus} error={props.taskError} onRetry={props.onRetry} />}
        </>
      }
    }
    if (props.pdfUrl) {
      const pdfUrl = props.pdfUrl
      specs.pdf = {
        label: 'PDF',
        icon: <FilePdfOutlined />,
        keepMounted: true,
        panelClassName: 'reader-pdf-panel',
        render: ({ actionsHost }) => <PdfPane
          url={pdfUrl}
          mappings={mappings}
          selection={props.selection}
          onSelect={props.onSelect}
          toolbarHost={actionsHost}
          initialViewState={pdfStateRef.current}
          onViewStateChange={rememberPdfState}
          scrollSync={syncHub.channel('pdf')}
        />
      }
    }
    if (props.chat) {
      const chat = props.chat
      specs.chat = {
        label: 'Chat',
        icon: <MessageOutlined />,
        tab: <ChatTabLabel controller={chat.controller} />,
        // Mounts on first visit only: the panel asks the Utility to build the
        // content index, which is CPU-heavy and must not run merely because a
        // paper was opened. Afterwards it stays mounted so scroll position and
        // streaming output survive tab switches.
        keepMounted: true,
        panelClassName: 'reader-tab-panel',
        render: ({ active, actionsHost }) => <>
          {actionsHost ? createPortal(<ReaderChatToolbar chat={chat.controller}>
            <PaperInsightActions key={props.taskId} documentId={props.taskId} source={chat.insights} onOpenSettings={chat.onOpenSettings} />
          </ReaderChatToolbar>, actionsHost) : null}
          <ReaderChatPanel
            documentId={props.taskId}
            chat={chat.controller}
            active={active}
            onSelect={chat.onCitation}
            onOpenSettings={chat.onOpenSettings}
          />
        </>
      }
    }
    return specs
  }, [
    highlightColor, mappings, originalAnnotations, originalFigureGroups, props.assetBaseUrl, props.chat,
    props.onAddToChat, props.onSelect, props.onOpenFigurePdf, props.originalBlocks, props.pdfUrl, props.selection, props.taskId,
    props.taskStatus, props.taskError, props.onRetry, props.translatedBlocks, props.translatedReady, rememberOriginalScroll, rememberPdfState,
    rememberTranslatedScroll, replaceOriginalAnnotations, replaceTranslatedAnnotations, syncHub, translatedAnnotations,
    translatedFigureGroups
  ])
}

const EMPTY_MAPPINGS: BlockMapping[] = []

function ReaderDocumentState(props: {
  view: 'original' | 'translated'
  status: DocumentWorkflowStatus
  error?: string | null
  onRetry?(): Promise<void>
}): React.JSX.Element {
  const [retrying, setRetrying] = React.useState(false)
  const failed = props.status === 'failed' || props.status === 'partial'
  const pending = ['queued', 'uploading', 'parsing', 'translating'].includes(props.status)
  const content = props.view === 'original' ? '原文' : '译文'
  const title = failed ? `${content}未生成，文档处理失败` : pending ? `${content}正在准备中` : `暂无${content}`
  const retry = async (): Promise<void> => {
    if (retrying || !props.onRetry) return
    setRetrying(true)
    try { await props.onRetry() } finally { setRetrying(false) }
  }
  const error = props.error && /fetch failed|failed to fetch|network|net::|econn|timeout/iu.test(props.error)
    ? '网络请求失败，请检查网络或代理设置后重试。'
    : props.error
  return <div className="reader-document-state" role={failed ? 'alert' : 'status'}>
    <strong>{title}</strong>
    <p>{error || (pending ? '处理完成后内容会自动显示，你可以先查看 PDF。' : '你可以先查看 PDF，或重试文档处理。')}</p>
    {canRetry(props.status) && props.onRetry ? <Button loading={retrying} onClick={() => void retry()}>重试文档处理</Button> : null}
  </div>
}

function ChatTabLabel(props: { controller: PaperChatController }): React.JSX.Element {
  const pinned = props.controller.pinned.length
  return (
    <span className="reader-chat-tab">
      Chat
      {props.controller.busy ? <span className="reader-chat-tab-busy" aria-label="正在生成" /> : null}
      {pinned > 0 ? <Badge count={pinned} size="small" color="var(--primary)" title="" /> : null}
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
