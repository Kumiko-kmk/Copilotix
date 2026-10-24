import { registerSavedFigureCrops } from './ReaderFigureSnapshot'
import React from 'react'
import type { ReaderNote } from '@shared/readerNotes'
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
import MarkdownPane, { type MarkdownBlockMenu } from './MarkdownPane'
import type { ReaderBlockMove } from './ReaderBlockReorder'
import type { ReaderBlockEditing } from './ReaderBlockEditing'
import PdfPane, { type PdfBlockMenu, type PdfViewState } from './PdfPane'
import ReaderChatPanel, { ReaderChatToolbar } from './ReaderChatPanel'
import PaperInsightActions from './PaperInsightActions'
import type { PaperChatController } from '../usePaperChat'
import type { ReaderViewId } from '../readerLayout'
import { buildReaderFigureGeometries, projectReaderFigureGroups, type ReaderFigureGroup } from '@shared/readerFigureGroups'
import { applyFigureDisplay, useFigureDisplayChoices } from '../readerFigureDisplay'
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
  /** The same blocks before the user's edits; figure grouping is computed on these once. */
  originalBaseBlocks?: ReaderBlock[]
  translatedBaseBlocks?: ReaderBlock[]
  translatedReady: boolean
  taskStatus: DocumentWorkflowStatus
  /** Translated blocks as "n/total" while translation is counted. */
  translationCount?: string | null
  taskError?: string | null
  onRetry?(): Promise<void>
  assetBaseUrl: string
  taskId: string
  annotations: ReaderAnnotation[]
  onReplaceAnnotations(view: ReaderAnnotationView, annotations: ReaderAnnotation[]): Promise<void>
  onAddToChat?(selection: ReaderChatSelection): void
  notes?: readonly ReaderNote[]
  onSaveNote?(note: ReaderNote): Promise<void>
  onDeleteNote?(noteId: string): Promise<void>
  selection: BlockSelection | null
  onSelect(selection: BlockSelection): void
  /** The user's edit layer, one controller per reading view. */
  blockEditing?: { original: ReaderBlockEditing; translated: ReaderBlockEditing }
  /** Right-click menu on PDF blocks. */
  pdfBlockMenu?: PdfBlockMenu
  /** Right-click menu on paragraphs and figures of the reading views. */
  markdownBlockMenu?: MarkdownBlockMenu
  /** Reordering of whole paragraphs and figures; the translation only when it lines up with the source. */
  blockMove?: { original?: ReaderBlockMove; translated?: ReaderBlockMove }
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
  const originalNotes = React.useMemo(() => (props.notes ?? []).filter((note) => note.view === 'original'), [props.notes])
  const translatedNotes = React.useMemo(() => (props.notes ?? []).filter((note) => note.view === 'translated'), [props.notes])
  // Registered during render: figure snapshots start in effects that run before this component's.
  if (props.pdfUrl) registerSavedFigureCrops(props.pdfUrl, props.assetBaseUrl)
  const figureGeometries = React.useMemo(() => buildReaderFigureGeometries(mappings, props.layoutJson), [mappings, props.layoutJson])
  useFigureArtifacts(props.taskId, props.pdfUrl, figureGeometries)
  const figureDisplay = useFigureDisplayChoices(props.taskId)
  // Figures are grouped on the unedited blocks, then re-indexed to the shown ones; a group keeps its
  // identity while its blocks do, so editing or deleting a paragraph does not re-render every figure.
  const originalBase = props.originalBaseBlocks ?? props.originalBlocks
  const translatedBase = props.translatedBaseBlocks ?? props.translatedBlocks
  const originalGroupCache = React.useRef(new Map<string, CachedGroup>())
  const translatedGroupCache = React.useRef(new Map<string, CachedGroup>())
  const originalProjected = React.useMemo(
    () => applyFigureDisplay(projectReaderFigureGroups(figureGeometries, originalBase), props.taskId, figureDisplay),
    [figureGeometries, originalBase, props.taskId, figureDisplay]
  )
  const originalFigureGroups = React.useMemo(
    () => remapFigureGroups(originalProjected, originalBase, props.originalBlocks, originalGroupCache.current),
    [originalProjected, originalBase, props.originalBlocks]
  )
  const translatedProjected = React.useMemo(
    () => applyFigureDisplay(projectReaderFigureGroups(figureGeometries, translatedBase, originalBase), props.taskId, figureDisplay),
    [figureGeometries, translatedBase, originalBase, props.taskId, figureDisplay]
  )
  const translatedFigureGroups = React.useMemo(
    () => remapFigureGroups(translatedProjected, translatedBase, props.translatedBlocks, translatedGroupCache.current),
    [translatedProjected, translatedBase, props.translatedBlocks]
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
    const originalReady = props.originalBlocks.some(block => block.role === 'content' && block.markdown.trim())
    const specs: ReaderViewSpecs = {
      original: {
        label: '原文',
        icon: <FileTextOutlined />,
        panelClassName: 'reader-tab-panel',
        render: ({ active }) => <>
          {!originalReady ? <ReaderDocumentState view="original" status={props.taskStatus} error={props.taskError} onRetry={props.onRetry} /> : active ? <MarkdownPane
          active
          blocks={props.originalBlocks}
          counterpartBlocks={props.translatedReady ? props.translatedBlocks : undefined}
          assetBaseUrl={props.assetBaseUrl}
          pdfUrl={props.pdfUrl}
          figureGroups={originalFigureGroups}
          blockEditing={props.blockEditing?.original}
          blockMenu={props.markdownBlockMenu}
          blockMove={props.blockMove?.original}
          taskId={props.taskId}
          view="original"
          annotations={originalAnnotations}
          highlightColor={highlightColor}
          onHighlightColorChange={setHighlightColor}
          onReplaceAnnotations={replaceOriginalAnnotations}
          onAddToChat={props.onAddToChat}
          notes={originalNotes}
          onSaveNote={props.onSaveNote}
          onDeleteNote={props.onDeleteNote}
          selection={props.selection}
          onSelect={props.onSelect}
          initialScrollTop={scrollPositionsRef.current.original}
          onScrollTopChange={rememberOriginalScroll}
          scrollSync={syncHub.channel('original')}
        /> : null}
        </>
      },
      translated: {
        label: '译文',
        icon: <TranslationOutlined />,
        panelClassName: 'reader-tab-panel',
        render: ({ active, actionsHost }) => <>
          {actionsHost ? createPortal(<Tag color={translationColor(props.taskStatus)}>{translationLabel(props.taskStatus, originalReady, props.translationCount ?? null)}</Tag>, actionsHost) : null}
          {props.translatedReady ? (active ? <MarkdownPane
            active
            blocks={props.translatedBlocks}
            counterpartBlocks={props.originalBlocks}
            assetBaseUrl={props.assetBaseUrl}
            pdfUrl={props.pdfUrl}
            figureGroups={translatedFigureGroups}
            blockEditing={props.blockEditing?.translated}
            blockMenu={props.markdownBlockMenu}
            blockMove={props.blockMove?.translated}
            taskId={props.taskId}
            view="translated"
            annotations={translatedAnnotations}
            highlightColor={highlightColor}
            onHighlightColorChange={setHighlightColor}
            onReplaceAnnotations={replaceTranslatedAnnotations}
            onAddToChat={props.onAddToChat}
            notes={translatedNotes}
            onSaveNote={props.onSaveNote}
            onDeleteNote={props.onDeleteNote}
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
          blockMenu={props.pdfBlockMenu}
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
            assetBaseUrl={props.assetBaseUrl}
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
    props.onAddToChat, props.onSaveNote, props.onDeleteNote, originalNotes, translatedNotes, props.onSelect, props.blockEditing, props.pdfBlockMenu, props.markdownBlockMenu, props.blockMove, props.originalBlocks, props.pdfUrl, props.selection, props.taskId,
    props.taskStatus, props.translationCount, props.taskError, props.onRetry, props.translatedBlocks, props.translatedReady, rememberOriginalScroll, rememberPdfState,
    rememberTranslatedScroll, replaceOriginalAnnotations, replaceTranslatedAnnotations, syncHub, translatedAnnotations,
    translatedFigureGroups
  ])
}

const EMPTY_MAPPINGS: BlockMapping[] = []

type CachedGroup = { source: ReaderFigureGroup; signature: string; group: ReaderFigureGroup }
/** Re-indexes groups from the unedited blocks to the shown ones (deleted blocks drop out). */
function remapFigureGroups(groups: ReaderFigureGroup[], base: readonly ReaderBlock[], shown: readonly ReaderBlock[], cache: Map<string, CachedGroup>): ReaderFigureGroup[] {
  if (base === shown) return groups
  const position = new Map<string, number>()
  shown.forEach((block, index) => { if (block.annotationKey) position.set(block.annotationKey, index) })
  const remap = (index: number): number | undefined => {
    const key = base[index]?.annotationKey
    return key === undefined ? undefined : position.get(key)
  }
  const result: ReaderFigureGroup[] = []
  for (const group of groups) {
    const members = group.memberBlockIndexes.flatMap(index => { const next = remap(index); return next === undefined ? [] : [next] })
    if (!members.length) continue
    const owner = remap(group.ownerBlockIndex) ?? members[0]!
    const caption = group.captionBlockIndex < 0 ? -1 : remap(group.captionBlockIndex) ?? -1
    const signature = [owner, caption, ...members].join(',')
    const cached = cache.get(group.id)
    if (cached && cached.source === group && cached.signature === signature) { result.push(cached.group); continue }
    const supportingTextsByBlock: Record<number, string[]> = {}
    for (const [index, texts] of Object.entries(group.supportingTextsByBlock ?? {})) {
      const next = remap(Number(index))
      if (next !== undefined) supportingTextsByBlock[next] = texts
    }
    const remapped = { ...group, ownerBlockIndex: owner, captionBlockIndex: caption, memberBlockIndexes: members, supportingTextsByBlock }
    cache.set(group.id, { source: group, signature, group: remapped })
    result.push(remapped)
  }
  return result
}

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
    <p>{error || (pending ? `${pendingStep(props.status)}，完成后内容会自动显示，你可以先查看 PDF。` : '你可以先查看 PDF，或重试文档处理。')}</p>
    {canRetry(props.status) && props.onRetry ? <Button loading={retrying} onClick={() => void retry()}>重试文档处理</Button> : null}
  </div>
}

function pendingStep(status: DocumentWorkflowStatus): string {
  if (status === 'uploading') return '正在上传 PDF'
  if (status === 'parsing') return '正在解析'
  if (status === 'queued') return '解析已完成，正在载入'
  return '正在翻译'
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

function translationLabel(status: DocumentWorkflowStatus, originalReady: boolean, count: string | null): string {
  if (status === 'completed') return '翻译完成'
  if (status === 'partial') return '部分翻译完成，可重试失败区块'
  if (status === 'failed') return '任务失败'
  if (status === 'translating') return count ? `正在翻译 ${count}` : '正在翻译'
  // Parsing has finished, but the original appears only once the reader has loaded it.
  if (status === 'queued') return originalReady ? '等待翻译，当前可阅读原文' : '解析完成，正在载入原文'
  if (status === 'uploading') return '正在上传 PDF，解析后可阅读原文'
  return '正在解析，完成后可阅读原文'
}

function translationColor(status: DocumentWorkflowStatus): string {
  if (status === 'completed') return 'success'
  if (status === 'partial') return 'warning'
  if (status === 'failed') return 'error'
  return 'processing'
}
