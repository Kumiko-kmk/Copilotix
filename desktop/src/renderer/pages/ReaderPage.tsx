import { paperSelectionText } from '@shared/paperSelectionText'
import { readerContentMappings } from '@shared/readerDocument'
import type { PdfBlockMenu, PdfBlockMenuItem } from '../components/PdfPane'
import React from 'react'
import { usePaperChat } from '../usePaperChat'
import { usePaperChatRouting } from '../usePaperChatRouting'
import { captionFigureKey } from '@shared/figureMentions'
import { paperChatFigureImagePathSchema } from '@shared/paperChatFigures'
import type { ReaderFigureGroup } from '@shared/readerFigureGroups'
import type { ReaderFigureChat } from '../components/MarkdownPane'
import type { ReaderBlockEditing } from '../components/ReaderBlockEditing'
import type { MarkdownEditRequest } from '@shared/markdownEdits'
import type { ReaderBlock } from '@shared/readerDocument'
import { useReaderNotes } from '../useReaderNotes'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeftOutlined, DownloadOutlined, FolderOpenOutlined } from '@ant-design/icons'
import { Button, Dropdown, Space, Spin, Typography, message } from 'antd'
import { buildOriginalReaderBlocks, buildTranslatedReaderBlocks } from '@shared/readerDocument'
import type {
  DocumentAnnotation,
  DocumentDetails,
  ListReaderAnnotationsRequest,
  ReaderAnnotationSnapshot
} from '@shared/ipcSchemas'
import type { BlockSelection, ReaderAnnotation, ReaderAnnotationView, ReaderChatSelection } from '@shared/types'
import { IpcClientError } from '@shared/ipc'
import { buildAnnotationDiff, replayAnnotationDiff } from '../annotationMutations'
import ReaderWorkbench from '../components/ReaderWorkbench'
import DocumentLifecycleActions from '../components/DocumentLifecycleActions'
import { translationCount } from '../documentStatus'
import { useTextLayerRepair } from '../useTextLayerRepair'
import ZoteroExportButton from '../components/ZoteroExportButton'
import type { PaperInsightSource } from '@shared/paperInsight'
import { useReaderViews, type ReaderChatOptions, type ReaderViewsInput } from '../components/ReaderViews'
import {
  activeSyncedViews,
  revealView,
  findGroup,
  groupOfView,
  listGroups,
  loadReaderLayout,
  saveReaderLayout,
  type ReaderLayout,
  type ReaderViewId
} from '../readerLayout'

export default function ReaderPage(props: { documentId: string; enterFromLibrary?: boolean; insights?: PaperInsightSource; onBack(): void; onOpenSettings(): void }): React.JSX.Element {
  const queryClient = useQueryClient()
  const chat = usePaperChat(props.documentId)
  const readerNotes = useReaderNotes(props.documentId)
  const [layout, setLayout] = React.useState<ReaderLayout>(loadReaderLayout)
  const [focusedGroupId, setFocusedGroupId] = React.useState<string | null>(null)
  const [revealReadingNonce, setRevealReadingNonce] = React.useState(0)
  const [revealPdfNonce, setRevealPdfNonce] = React.useState(0)
  const [selection, setSelection] = React.useState<BlockSelection | null>(null)
  const [messageApi, contextHolder] = message.useMessage()
  const retryDocument = React.useCallback(async () => {
    try {
      await window.copilotix.retryDocument(props.documentId)
      messageApi.success('已重新排队，将保留已完成的内容')
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : '重试失败，请稍后再试')
    }
  }, [messageApi, props.documentId])

  const documentQuery = useQuery<DocumentDetails>({
    queryKey: ['document', props.documentId],
    queryFn: () => window.copilotix.getDocument(props.documentId)
  })
  const originalAnnotations = useAnnotationQuery(props.documentId, 'original')
  const translatedAnnotations = useAnnotationQuery(props.documentId, 'translated')
  const document = documentQuery.data
  const repairRevision = useTextLayerRepair(props.documentId, document?.layoutJson, messageApi)
  const snapshots = React.useMemo(
    () => ({ original: originalAnnotations.data, translated: translatedAnnotations.data }),
    [originalAnnotations.data, translatedAnnotations.data]
  )
  // Keep this identity stable: every scroll-synced selection re-renders the
  // page, and a fresh array would rebuild all highlight ranges of a long paper.
  const annotations = React.useMemo(() => [
    ...(snapshots.original?.annotations ?? []).map(toLegacyAnnotation),
    ...(snapshots.translated?.annotations ?? []).map(toLegacyAnnotation)
  ], [snapshots])

  React.useEffect(() => {
    setSelection(null)
  }, [props.documentId])

  React.useEffect(() => saveReaderLayout(layout), [layout])
  // Copy and save follow the group the reader last used.
  const focusedView: ReaderViewId = (focusedGroupId ? findGroup(layout, focusedGroupId) : undefined)?.active
    ?? groupOfView(layout, 'original')?.active
    ?? listGroups(layout.root)[0]!.active

  const markdown = document?.markdown ?? ''
  const translatedMarkdown = document?.translatedMarkdown ?? ''
  const translatedSourceBlocks = document?.translatedBlocks ?? null
  const mappings = document?.mappings ?? EMPTY_MAPPINGS
  const markdownEdits = document?.markdownEdits ?? null
  const originalBlocks = React.useMemo(
    () => buildOriginalReaderBlocks(markdown, mappings, markdownEdits),
    [markdown, mappings, markdownEdits]
  )
  const translatedBlocks = React.useMemo(
    () => buildTranslatedReaderBlocks(markdown, translatedMarkdown, translatedSourceBlocks, mappings, markdownEdits),
    [markdown, mappings, translatedMarkdown, translatedSourceBlocks, markdownEdits]
  )
  const selectBlock = React.useCallback((next: BlockSelection) => setSelection(next), [])
  const openFigurePdf = React.useCallback((next: BlockSelection) => {
    setLayout(current => revealView(current, 'pdf'))
    setSelection(next)
    setRevealPdfNonce(value => value + 1)
  }, [])

  // Adding a selection never leaves the current reader; the chat tab shows the count.
  const { addSelection } = chat
  const addToChat = React.useCallback((selection: ReaderChatSelection) => {
    void addSelection(selection).then((failure) => {
      if (failure) messageApi.warning({ content: failure, key: 'paper-chat-pin' })
      else messageApi.success({ content: '已加入 Chat 选区', key: 'paper-chat-pin', duration: 1.5 })
    })
  }, [addSelection, messageApi])
  // Figures follow the same rule; a text-only model blocks them with a visible reason.
  const routing = usePaperChatRouting(chat.selectedModel, { inspect: false })
  const { addFigure } = chat
  const figureChat = React.useMemo<ReaderFigureChat>(() => ({
    blocked: routing.imageBlocked,
    onAdd: (group: ReaderFigureGroup) => {
      if (routing.imageBlocked) { messageApi.warning({ content: routing.imageBlocked, key: 'paper-chat-pin' }); return }
      const label = captionFigureKey(group.captionMarkdown || group.fallbackLegendText)?.label ?? null
      const preview = group.assetSources.map(asset => 'images/' + (asset.replace(/\\/gu, '/').split('/').pop() ?? '')).find(path => paperChatFigureImagePathSchema.safeParse(path).success)
      void addFigure({ figureId: group.id, label, pageIndex: group.pageIndex, ...(preview ? { preview } : {}) }).then((failure) => {
        if (failure) messageApi.warning({ content: failure, key: 'paper-chat-pin' })
        else messageApi.success({ content: label ? `已将 ${label} 加入 Chat` : '已将图片加入 Chat', key: 'paper-chat-pin', duration: 1.5 })
      })
    }
  }), [addFigure, messageApi, routing.imageBlocked])
  // The user's edit layer. Every change is saved by Utility and the document reloaded, so the
  // reader, translation, chat and exports all see the same text.
  const editsUnreadable = document !== undefined && document.markdownEdits === null
  const editRevision = markdownEdits?.revision ?? 0
  const applyEdit = React.useCallback(async (target: MarkdownEditRequest['target'], action: MarkdownEditRequest['action'], text?: string): Promise<void> => {
    if (editsUnreadable) throw new Error('段落修改文件无法读取，请检查文献目录中的 edits 文件夹')
    await window.copilotix.editDocumentMarkdown({ documentId: props.documentId, expectedRevision: editRevision, target, action, ...(text !== undefined ? { markdown: text } : {}) })
    await queryClient.invalidateQueries({ queryKey: ['document', props.documentId] })
  }, [editRevision, editsUnreadable, props.documentId, queryClient])
  const blockEditing = React.useMemo(() => {
    const targetOf = (block: ReaderBlock): MarkdownEditRequest['target'] => block.role === 'content' && block.contentIndex !== undefined
      ? { kind: 'content', index: block.contentIndex, mappingIds: block.mappingIds }
      : { kind: 'supplemental', mappingId: (block.annotationKey ?? '').replace(/^supplemental:/u, '') }
    const report = async (action: () => Promise<void>): Promise<void> => {
      try { await action() } catch (error) { messageApi.error({ content: error instanceof Error ? error.message : '段落修改失败', key: 'reader-edit' }) }
    }
    const restore = (target: { index: number } | { mappingId: string }): Promise<void> => report(() => 'index' in target
      ? applyEdit({ kind: 'content', index: target.index, mappingIds: markdownEdits?.blocks.find(block => block.index === target.index)?.mappingIds ?? [] }, 'restore')
      : applyEdit({ kind: 'supplemental', mappingId: target.mappingId }, 'restore'))
    const make = (view: 'original' | 'translated'): ReaderBlockEditing => ({
      view, edits: markdownEdits, restore,
      save: (block, text) => applyEdit(targetOf(block), view === 'original' ? 'set-original' : 'set-translated', text),
    })
    return { original: make('original'), translated: make('translated') }
  }, [applyEdit, markdownEdits, messageApi])
  // Right click on a PDF block: retranslate, ask about, frame, delete or restore the whole paragraph.
  const translationAvailable = Boolean(document?.translatedMarkdown)
  const contentMappingIds = React.useMemo(() => new Set(readerContentMappings(mappings).map(mapping => mapping.id)), [mappings])
  const pdfBlockMenu = React.useMemo<PdfBlockMenu>(() => {
    const boxed = new Set(markdownEdits?.boxMarks ?? [])
    const deletedContent = (id: string) => markdownEdits?.blocks.find(block => block.deleted && block.mappingIds.includes(id))
    const deletedSupplemental = (id: string) => Boolean(markdownEdits?.supplementalDeleted.some(item => item.mappingId === id))
    const deleted = new Set([...(markdownEdits?.blocks.filter(block => block.deleted).flatMap(block => block.mappingIds) ?? []),
      ...(markdownEdits?.supplementalDeleted.map(item => item.mappingId) ?? [])])
    const contentOf = (id: string) => originalBlocks.find(block => block.role === 'content' && block.contentIndex !== undefined && block.mappingIds.includes(id))
    const report = async (action: () => Promise<void>): Promise<void> => {
      try { await action() } catch (error) { messageApi.error({ content: error instanceof Error ? error.message : '段落操作失败', key: 'reader-edit' }) }
    }
    return {
      boxed, deleted,
      items: (id) => {
        const content = contentOf(id)
        const furniture = !contentMappingIds.has(id)
        const items: PdfBlockMenuItem[] = []
        if (content && translationAvailable) items.push({ key: 'retranslate', label: '重新翻译此段' })
        if (content) items.push({ key: 'chat', label: '整段加入对话' })
        items.push(boxed.has(id) ? { key: 'unbox', label: '取消边界框标记' } : { key: 'box', label: '整段加边界框标记' })
        if (deletedContent(id) || deletedSupplemental(id)) items.push({ key: 'restore', label: '恢复此段' })
        else if (content || furniture) items.push({ key: 'delete', label: '删除此段', danger: true })
        return items
      },
      onSelect: (key, id) => {
        const content = contentOf(id)
        const contentTarget = content ? { kind: 'content' as const, index: content.contentIndex!, mappingIds: content.mappingIds } : null
        if (key === 'box' || key === 'unbox') void report(() => applyEdit({ kind: 'block', mappingId: id }, key))
        else if (key === 'retranslate' && contentTarget) void report(async () => {
          await applyEdit(contentTarget, 'retranslate')
          await window.copilotix.retranslateEditedDocument(props.documentId)
          messageApi.success({ key: 'reader-edit', content: '已开始重新翻译此段，其他段落沿用已有译文' })
          await queryClient.invalidateQueries({ queryKey: ['document', props.documentId] })
        })
        else if (key === 'chat' && content) {
          // The whole paragraph as an original-text selection, validated like a dragged one.
          const text = paperSelectionText(content.source ?? content.markdown).trim().slice(0, 16_000)
          if (!text) { messageApi.warning({ key: 'paper-chat-pin', content: '此段没有可加入对话的文字' }); return }
          const quote = text.slice(0, 4_096).replace(/[\uD800-\uDBFF]$/u, '')
          addToChat({ taskId: props.documentId, view: 'original', text, fragments: [{ blockKey: content.annotationKey!, startOffset: 0, endOffset: quote.length, quote, mappingIds: [...new Set(content.mappingIds)], ...(content.pageIndex !== undefined ? { pageIndex: content.pageIndex } : {}) }] })
        } else if (key === 'delete') {
          const target = contentTarget ?? { kind: 'supplemental' as const, mappingId: id }
          void report(async () => {
            await applyEdit(target, 'delete')
            messageApi.success({ key: 'reader-edit', duration: 6, content: <span>已删除此段，原文与译文均不再显示。<a onClick={() => { messageApi.destroy('reader-edit'); void report(() => applyEdit(target, 'restore')) }}>撤销</a></span> })
          })
        } else if (key === 'restore') {
          const entry = deletedContent(id)
          void report(() => applyEdit(entry ? { kind: 'content', index: entry.index, mappingIds: entry.mappingIds } : { kind: 'supplemental', mappingId: id }, 'restore'))
        }
      }
    }
  }, [addToChat, applyEdit, contentMappingIds, markdownEdits, messageApi, originalBlocks, props.documentId, queryClient, translationAvailable])
  // A citation scrolls the reading views to its block; if none is on screen, the workbench shows one.
  const openCitation = React.useCallback((next: BlockSelection) => {
    selectBlock(next)
    setRevealReadingNonce((value) => value + 1)
  }, [selectBlock])
  const chatOptions = React.useMemo<ReaderChatOptions>(() => ({
    controller: chat,
    insights: props.insights,
    onOpenSettings: props.onOpenSettings,
    onCitation: openCitation
  }), [chat, openCitation, props.insights, props.onOpenSettings])

  const replaceAnnotations = React.useCallback(async (
    view: ReaderAnnotationView,
    nextViewAnnotations: ReaderAnnotation[]
  ): Promise<void> => {
    const snapshot = snapshots[view]
    if (!snapshot) {
      messageApi.error('当前文档尚无可标注的产物')
      return
    }
    const queryKey = ['annotations', props.documentId, view]
    const next = nextViewAnnotations.map((annotation) => toDocumentAnnotation(annotation, snapshot))
    const diff = buildAnnotationDiff(snapshot.annotations, next)
    const optimistic: ReaderAnnotationSnapshot = { ...snapshot, annotations: next }
    queryClient.setQueryData(queryKey, optimistic)
    try {
      const saved = await mutateAnnotations(snapshot, diff)
      queryClient.setQueryData(queryKey, saved)
    } catch (error) {
      if (error instanceof IpcClientError && error.code === 'ANNOTATION_CONFLICT') {
        try {
          const latest = await reloadAnnotationSnapshot(props.documentId, view, queryClient)
          const replay = replayAnnotationDiff(snapshot.annotations, latest.annotations, diff)
          const saved = replay.upserts.length > 0 || replay.deleteIds.length > 0
            ? await mutateAnnotations(latest, replay)
            : latest
          queryClient.setQueryData(queryKey, saved)
          return
        } catch (replayError) {
          queryClient.setQueryData(queryKey, replayError instanceof IpcClientError && replayError.code === 'ANNOTATION_CONFLICT'
            ? await reloadAnnotationSnapshot(props.documentId, view, queryClient)
            : snapshot)
          messageApi.error(replayError instanceof Error ? replayError.message : '标注保存失败')
          return
        }
      }
      queryClient.setQueryData(queryKey, snapshot)
      messageApi.error(error instanceof Error ? error.message : '标注保存失败')
    }
  }, [messageApi, props.documentId, queryClient, snapshots])

  if (documentQuery.isError) return <div className="reader-loading">文档加载失败：{documentQuery.error.message}</div>
  if (documentQuery.isPending || !document) return <div className="reader-loading"><Spin size="large" /></div>

  const translatedReady = Boolean(document.translatedMarkdown)
  return (
    <section className={`reader-page${props.enterFromLibrary ? ' reader-from-library' : ''}`}>
      {contextHolder}
      <header className="reader-header">
        <div className="reader-header-heading"><Button type="text" icon={<ArrowLeftOutlined />} onClick={props.onBack} aria-label="返回" /><Typography.Text strong ellipsis className="reader-title">{document.summary.displayName.replace(/\.pdf\s*$/iu, '')}</Typography.Text></div>
        <Space className="reader-header-actions">
          <Button type="text" icon={<FolderOpenOutlined />} onClick={() => void window.copilotix.openDocumentOutput(document.summary.id)} aria-label="打开输出目录" />
          <Dropdown menu={{ items: [...(focusedView === 'original' || focusedView === 'translated' ? [{ key: 'current', label: '另存当前 Markdown' }] : []), { key: 'zip', label: '另存完整结果 ZIP' }], onClick: ({ key }) => void saveDocument(document.summary.id, key, focusedView, messageApi) }}>
            <Button type="text" icon={<DownloadOutlined />} aria-label="另存" />
          </Dropdown>
          <ZoteroExportButton documentId={document.summary.id} messageApi={messageApi} />
          <DocumentLifecycleActions summary={document.summary} staleTranslation={document.translatedBlocks?.some((block) => block.sourceChanged)} messageApi={messageApi} onDeleted={props.onBack} />
        </Space>
      </header>
      <ReaderWorkspace
        key={`${document.summary.id}:${repairRevision}`}
        layout={layout}
        onLayoutChange={setLayout}
        focusedGroupId={focusedGroupId}
        onFocusGroup={setFocusedGroupId}
        revealReadingNonce={revealReadingNonce}
        revealPdfNonce={revealPdfNonce}
        views={{
          pdfUrl: document.pdfUrl,
          mappings: document.mappings,
          layoutJson: document.layoutJson,
          originalBlocks,
          translatedBlocks,
          translatedReady,
          taskStatus: document.summary.workflow.status,
          translationCount: translationCount(document.summary.workflow),
          taskError: document.summary.workflow.error,
          onRetry: retryDocument,
          assetBaseUrl: document.assetBaseUrl,
          taskId: document.summary.id,
          annotations,
          onReplaceAnnotations: replaceAnnotations,
          selection,
          onSelect: selectBlock,
          onOpenFigurePdf: openFigurePdf,
          onAddToChat: addToChat,
          figureChat,
          blockEditing,
          pdfBlockMenu,
          notes: readerNotes.notes,
          onSaveNote: readerNotes.saveNote,
          onDeleteNote: readerNotes.deleteNote,
          chat: chatOptions
        }}
      />
    </section>
  )
}

/**
 * Per-paper part of the reader. Keyed by document so view state (scroll
 * positions, PDF position, lazily mounted chat) starts fresh for each paper,
 * while the layout itself is global and survives switching papers.
 */
function ReaderWorkspace(props: {
  layout: ReaderLayout
  onLayoutChange(layout: ReaderLayout): void
  focusedGroupId: string | null
  onFocusGroup(groupId: string): void
  revealReadingNonce: number
  revealPdfNonce: number
  views: ReaderViewsInput
}): React.JSX.Element {
  const scrollSyncViews = React.useMemo(() => activeSyncedViews(props.layout), [props.layout])
  const specs = useReaderViews({ ...props.views, scrollSyncViews })
  return (
    <ReaderWorkbench
      layout={props.layout}
      specs={specs}
      focusedGroupId={props.focusedGroupId}
      onLayoutChange={props.onLayoutChange}
      onFocusGroup={props.onFocusGroup}
      revealReadingNonce={props.revealReadingNonce}
      revealPdfNonce={props.revealPdfNonce}
    />
  )
}

const EMPTY_MAPPINGS: DocumentDetails['mappings'] = []

function useAnnotationQuery(documentId: string, view: ReaderAnnotationView) {
  const request: ListReaderAnnotationsRequest = { documentId, view }
  return useQuery<ReaderAnnotationSnapshot>({
    queryKey: ['annotations', documentId, view],
    queryFn: () => window.copilotix.listReaderAnnotations(request),
    retry: false
  })
}

async function mutateAnnotations(
  snapshot: ReaderAnnotationSnapshot,
  diff: ReturnType<typeof buildAnnotationDiff>
): Promise<ReaderAnnotationSnapshot> {
  return window.copilotix.mutateReaderAnnotations({
    documentId: snapshot.documentId,
    artifactId: snapshot.artifactId,
    view: snapshot.view,
    expectedRevision: snapshot.revision,
    upserts: diff.upserts,
    deleteIds: diff.deleteIds
  })
}

async function reloadAnnotationSnapshot(
  documentId: string,
  view: ReaderAnnotationView,
  queryClient: ReturnType<typeof useQueryClient>
): Promise<ReaderAnnotationSnapshot> {
  return queryClient.fetchQuery({
    queryKey: ['annotations', documentId, view],
    queryFn: () => window.copilotix.listReaderAnnotations({ documentId, view }),
    retry: false
  })
}

function toLegacyAnnotation(annotation: DocumentAnnotation): ReaderAnnotation {
  return {
    id: annotation.id,
    taskId: annotation.documentId,
    view: annotation.view,
    kind: annotation.kind,
    color: annotation.color,
    blockKey: annotation.blockKey,
    startOffset: annotation.startOffset,
    endOffset: annotation.endOffset,
    quote: annotation.quote,
    prefix: annotation.prefix,
    suffix: annotation.suffix,
    createdAt: annotation.createdAt,
    updatedAt: annotation.updatedAt
  }
}

function toDocumentAnnotation(annotation: ReaderAnnotation, snapshot: ReaderAnnotationSnapshot): DocumentAnnotation {
  return {
    id: annotation.id,
    documentId: snapshot.documentId,
    artifactId: snapshot.artifactId,
    view: snapshot.view,
    kind: annotation.kind,
    color: annotation.color,
    blockKey: annotation.blockKey,
    startOffset: annotation.startOffset,
    endOffset: annotation.endOffset,
    quote: annotation.quote,
    prefix: annotation.prefix,
    suffix: annotation.suffix,
    createdAt: annotation.createdAt,
    updatedAt: annotation.updatedAt
  }
}

async function saveDocument(
  documentId: string,
  key: string,
  view: ReaderViewId,
  messageApi: ReturnType<typeof message.useMessage>[0]
): Promise<void> {
  const result = await window.copilotix.saveDocumentAs({
    documentId,
    kind: key === 'zip' ? 'result-zip' : view === 'translated' ? 'translated-markdown' : 'original-markdown'
  })
  if (result.saved) messageApi.success(key === 'zip' ? '已保存' : '已保存；含图片时，请将文档与旁边的图片文件夹一同传递')
}
