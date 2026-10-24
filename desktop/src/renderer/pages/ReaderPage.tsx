import { paperSelectionText } from '@shared/paperSelectionText'
import { readerContentMappings } from '@shared/readerDocument'
import type { PdfBlockMenu } from '../components/PdfPane'
import type { BlockMenuItem } from '../components/BlockContextMenu'
import type { MarkdownBlockMenu } from '../components/MarkdownPane'
import { automaticFigureDisplay, setFigureDisplayChoice } from '../readerFigureDisplay'
import { TRANSLATION_PROVIDER_LABELS } from '@shared/providerPolicy'
import React from 'react'
import { usePaperChat } from '../usePaperChat'
import { usePaperChatRouting } from '../usePaperChatRouting'
import { captionFigureKey } from '@shared/figureMentions'
import { paperChatFigureImagePathSchema } from '@shared/paperChatFigures'
import type { ReaderFigureGroup } from '@shared/readerFigureGroups'
import type { ReaderFigureChat } from '../components/MarkdownPane'
import type { ReaderBlockEditing } from '../components/ReaderBlockEditing'
import { moveInOrder, optimisticEdits, type MarkdownEditRequest, type ResolvedMarkdownEdits } from '@shared/markdownEdits'
import type { ReaderBlockMove } from '../components/ReaderBlockReorder'
import type { ReaderBlock } from '@shared/readerDocument'
import { useReaderNotes } from '../useReaderNotes'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeftOutlined, DownloadOutlined, FolderOpenOutlined } from '@ant-design/icons'
import { Button, Dropdown, Space, Spin, Typography, message } from 'antd'
import { buildReaderBase, buildTranslatedBase, withReaderEdits } from '@shared/readerDocument'
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
  // Parsed and translated blocks are built once; an edit only re-applies the edit layer on top.
  const readerBase = React.useMemo(() => buildReaderBase(markdown, mappings), [markdown, mappings])
  const translatedBase = React.useMemo(
    () => buildTranslatedBase(readerBase, translatedMarkdown, translatedSourceBlocks, mappings),
    [readerBase, mappings, translatedMarkdown, translatedSourceBlocks]
  )
  const originalBlocks = React.useMemo(() => withReaderEdits(readerBase.original, markdownEdits, 'original'), [readerBase, markdownEdits])
  const translatedBlocks = React.useMemo(
    () => translatedBase.indexed ? withReaderEdits(translatedBase.blocks, markdownEdits, 'translated') : translatedBase.blocks,
    [translatedBase, markdownEdits]
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
  // The user's edit layer. A change shows at once (optimistic), saves are sent one at a time, and
  // Main's resolved layer replaces the optimistic one; the paper itself is never reloaded for it.
  const editsUnreadable = document !== undefined && document.markdownEdits === null
  const editQueueRef = React.useRef<Promise<unknown>>(Promise.resolve())
  const pendingEditsRef = React.useRef(0)
  const editRevisionRef = React.useRef(0)
  if (pendingEditsRef.current === 0) editRevisionRef.current = markdownEdits?.revision ?? 0
  const setEdits = React.useCallback((update: (current: ResolvedMarkdownEdits | null) => ResolvedMarkdownEdits) => {
    queryClient.setQueryData<DocumentDetails>(['document', props.documentId], (current) => current ? { ...current, markdownEdits: update(current.markdownEdits ?? null) } : current)
  }, [props.documentId, queryClient])
  const applyEdit = React.useCallback((target: MarkdownEditRequest['target'], action: MarkdownEditRequest['action'], text?: string, shownText?: string): Promise<void> => {
    if (editsUnreadable) return Promise.reject(new Error('段落修改文件无法读取，请检查文献目录中的 edits 文件夹'))
    const request = { target, action, ...(text !== undefined ? { markdown: text } : {}) }
    setEdits((current) => optimisticEdits(current, request, shownText ?? text ?? ''))
    pendingEditsRef.current++
    const run = editQueueRef.current.then(async () => {
      const result = await window.copilotix.editDocumentMarkdown({ documentId: props.documentId, expectedRevision: editRevisionRef.current, ...request })
      editRevisionRef.current = result.revision
      // Later optimistic changes stay on screen until their own answer arrives.
      if (pendingEditsRef.current === 1 && result.edits) setEdits(() => result.edits!)
    }).finally(() => { pendingEditsRef.current-- })
    editQueueRef.current = run.catch(() => undefined)
    return run.catch(async (error: unknown) => {
      // The saved state is the truth: reload it rather than leave a change that was not kept.
      await queryClient.invalidateQueries({ queryKey: ['document', props.documentId] })
      throw error
    })
  }, [editsUnreadable, props.documentId, queryClient, setEdits])
  const blockEditing = React.useMemo(() => {
    const targetOf = (block: ReaderBlock): MarkdownEditRequest['target'] => block.role === 'content' && block.contentIndex !== undefined
      ? { kind: 'content', index: block.contentIndex, mappingIds: block.mappingIds }
      : { kind: 'supplemental', mappingId: (block.annotationKey ?? '').replace(/^supplemental:/u, '') }
    const report = async (action: () => Promise<void>): Promise<void> => {
      try { await action() } catch (error) { messageApi.error({ content: error instanceof Error ? error.message : '段落修改失败', key: 'reader-edit' }) }
    }
    const make = (view: 'original' | 'translated'): ReaderBlockEditing => ({
      view,
      save: (block, text) => { void report(() => applyEdit(targetOf(block), view === 'original' ? 'set-original' : 'set-translated', text)); return Promise.resolve() },
    })
    return { original: make('original'), translated: make('translated') }
  }, [applyEdit, messageApi])
  const translationAvailable = Boolean(document?.translatedMarkdown)
  // Reading order: the whole sequence is saved, so a move never depends on blocks the view hides.
  const blockMove = React.useMemo<ReaderBlockMove>(() => {
    const count = readerBase.content.length
    const save = (sequence: number[], action: 'reorder' | 'reset-order'): void => {
      void applyEdit({ kind: 'order', sequence }, action).catch(error => messageApi.error({ key: 'reader-edit', content: error instanceof Error ? error.message : '顺序保存失败' }))
    }
    return {
      ordered: Boolean(markdownEdits?.order),
      move: (unit, before) => save(moveInOrder(markdownEdits?.order ?? Array.from({ length: count }, (_, index) => index), unit, before), 'reorder'),
      reset: () => save([], 'reset-order')
    }
  }, [applyEdit, markdownEdits?.order, messageApi, readerBase])
  const viewMoves = React.useMemo(() => ({ original: blockMove, ...(translatedBase.indexed ? { translated: blockMove } : {}) }), [blockMove, translatedBase.indexed])
  const contentMappingIds = React.useMemo(() => new Set(readerContentMappings(mappings).map(mapping => mapping.id)), [mappings])
  // One set of paragraph and figure actions behind every right-click menu (PDF boxes, paragraphs,
  // page headers, figures). A merged paragraph has several PDF boxes but is one reader paragraph.
  const blockMenus = React.useMemo(() => {
    type Subject = { contents: ReaderBlock[]; deleted: ResolvedMarkdownEdits['blocks']; furnitureId?: string; boxId?: string; figures: ReaderFigureGroup[]; stale: boolean; fallback?: string }
    const boxed = new Set(markdownEdits?.boxMarks ?? [])
    const originalByIndex = new Map(originalBlocks.flatMap(block => block.role === 'content' && block.contentIndex !== undefined ? [[block.contentIndex, block] as const] : []))
    const translatedByIndex = new Map(translatedBlocks.flatMap(block => block.role === 'content' && block.contentIndex !== undefined ? [[block.contentIndex, block] as const] : []))
    const staleIndex = (index: number | undefined): boolean => index !== undefined && Boolean(translatedByIndex.get(index)?.edit?.stale || translatedByIndex.get(index)?.sourceChanged)
    const furnitureDeleted = (id: string): boolean => Boolean(markdownEdits?.supplementalDeleted.some(item => item.mappingId === id))
    const fromMapping = (id: string): Subject => {
      const contents = originalBlocks.filter(block => block.role === 'content' && block.contentIndex !== undefined && block.mappingIds.includes(id))
      return { contents, deleted: markdownEdits?.blocks.filter(block => block.deleted && block.mappingIds.includes(id)) ?? [],
        ...(contentMappingIds.has(id) ? {} : { furnitureId: id }), boxId: id, figures: [], stale: contents.some(block => staleIndex(block.contentIndex)) }
    }
    const fromBlock = (block: ReaderBlock, figures: ReaderFigureGroup[]): Subject => {
      if (block.role !== 'content') {
        const id = (block.annotationKey ?? '').replace(/^supplemental:/u, '')
        return { contents: [], deleted: [], furnitureId: id, boxId: id, figures: [], stale: false }
      }
      const original = block.contentIndex === undefined ? undefined : originalByIndex.get(block.contentIndex)
      // A figure is deleted with its caption: every paragraph of the group goes.
      const members = figures.flatMap(group => group.mappingIds).length
        ? originalBlocks.filter(candidate => candidate.role === 'content' && figures.some(group => candidate.mappingIds.some(id => group.mappingIds.includes(id))))
        : []
      const contents = [...new Set([...(original ? [original] : []), ...members])]
      // Deleted neighbours without a PDF box can only be restored from here.
      const unmappedDeleted = markdownEdits?.blocks.filter(entry => entry.deleted && !entry.mappingIds.length && block.contentIndex !== undefined && Math.abs(entry.index - block.contentIndex) === 1) ?? []
      return { contents, deleted: unmappedDeleted, ...(block.mappingIds[0] ? { boxId: block.mappingIds[0] } : {}), figures,
        stale: staleIndex(block.contentIndex), ...(block.fallbackProvider ? { fallback: TRANSLATION_PROVIDER_LABELS[block.fallbackProvider] } : {}) }
    }
    const report = async (action: () => Promise<void>): Promise<void> => {
      try { await action() } catch (error) { messageApi.error({ content: error instanceof Error ? error.message : '段落操作失败', key: 'reader-edit' }) }
    }
    const contentTarget = (block: ReaderBlock): MarkdownEditRequest['target'] => ({ kind: 'content', index: block.contentIndex!, mappingIds: block.mappingIds })
    const items = (subject: Subject): BlockMenuItem[] => {
      const result: BlockMenuItem[] = []
      if (subject.stale) result.push({ key: 'note-stale', label: '译文待更新：原文已修改', note: true })
      if (subject.fallback) result.push({ key: 'note-fallback', label: `此段由 ${subject.fallback} 回退翻译`, note: true })
      const figure = subject.figures[0]
      if (figure) {
        result.push({ key: 'figure-chat', label: figureChat.blocked ? `加入问答（${figureChat.blocked}）` : '图片加入问答', disabled: Boolean(figureChat.blocked) })
        if (figure.display && (figure.assetSources.length || figure.display.choice)) result.push({ key: 'figure-display', label: figure.status === 'complete' ? '以解析子图显示' : '以 PDF 原图显示' })
        result.push({ key: 'figure-pdf', label: '在 PDF 中查看' })
      }
      if (subject.contents.length && translationAvailable) result.push({ key: 'retranslate', label: '重新翻译此段' })
      if (subject.contents.length && !figure) result.push({ key: 'chat', label: '整段加入对话' })
      if (subject.boxId) result.push(boxed.has(subject.boxId) ? { key: 'unbox', label: '取消边界框标记' } : { key: 'box', label: '整段加边界框标记' })
      if (subject.deleted.length || (subject.furnitureId && furnitureDeleted(subject.furnitureId))) result.push({ key: 'restore', label: subject.contents.length ? '恢复相邻的已删除段落' : '恢复此段' })
      if (subject.contents.length || (subject.furnitureId && !furnitureDeleted(subject.furnitureId))) result.push({ key: 'delete', label: figure ? '删除此图' : '删除此段', danger: true })
      return result
    }
    const select = (key: string, subject: Subject): void => {
      const [first] = subject.contents
      if (key === 'box' || key === 'unbox') { if (subject.boxId) void report(() => applyEdit({ kind: 'block', mappingId: subject.boxId! }, key)) }
      else if (key === 'retranslate' && first) void report(async () => {
        for (const block of subject.contents) await applyEdit(contentTarget(block), 'retranslate')
        await window.copilotix.retranslateEditedDocument(props.documentId)
        messageApi.success({ key: 'reader-edit', content: '已开始重新翻译此段，其他段落沿用已有译文' })
        await queryClient.invalidateQueries({ queryKey: ['document', props.documentId] })
      })
      else if (key === 'chat' && first) {
        // The whole paragraph as an original-text selection, validated like a dragged one.
        const text = paperSelectionText(first.source ?? first.markdown).trim().slice(0, 16_000)
        if (!text) { messageApi.warning({ key: 'paper-chat-pin', content: '此段没有可加入对话的文字' }); return }
        const quote = text.slice(0, 4_096).replace(/[\uD800-\uDBFF]$/u, '')
        addToChat({ taskId: props.documentId, view: 'original', text, fragments: [{ blockKey: first.annotationKey!, startOffset: 0, endOffset: quote.length, quote, mappingIds: [...new Set(first.mappingIds)], ...(first.pageIndex !== undefined ? { pageIndex: first.pageIndex } : {}) }] })
      } else if (key === 'figure-chat' && subject.figures[0]) figureChat.onAdd(subject.figures[0])
      else if (key === 'figure-display' && subject.figures[0]?.display) {
        const group = subject.figures[0]
        // Choosing what the figure shows by default clears the stored choice.
        const next = group.status === 'complete' ? 'parsed' : 'pdf'
        void setFigureDisplayChoice(props.documentId, group.id, next === automaticFigureDisplay(group.display!.automatic) ? null : next).catch(() => messageApi.error({ key: 'reader-edit', content: '显示方式保存失败' }))
      } else if (key === 'figure-pdf' && subject.figures[0]) {
        const group = subject.figures[0]
        const mappingId = group.captionMappingId || group.mappingIds[0]
        if (mappingId) openFigurePdf({ mappingId, blockPosition: group.captionBlockPosition || group.members.find(member => member.mappingId === mappingId)?.blockPosition, origin: 'markdown' })
      } else if (key === 'delete') {
        const targets: MarkdownEditRequest['target'][] = subject.contents.length ? subject.contents.map(contentTarget) : subject.furnitureId ? [{ kind: 'supplemental', mappingId: subject.furnitureId }] : []
        const shown = first?.source ?? mappings.find(mapping => mapping.id === subject.furnitureId)?.sourceText
        void report(async () => {
          const saved = Promise.all(targets.map(target => applyEdit(target, 'delete', undefined, shown)))
          const undo = (): void => { messageApi.destroy('reader-edit'); void report(async () => { await Promise.all(targets.map(target => applyEdit(target, 'restore'))) }) }
          messageApi.success({ key: 'reader-edit', duration: 6, content: <span>{subject.figures.length ? '已删除此图' : '已删除此段'}，原文与译文均不再显示。<a onClick={undo}>撤销</a></span> })
          await saved
        })
      } else if (key === 'restore') {
        const targets: MarkdownEditRequest['target'][] = subject.deleted.map(entry => ({ kind: 'content', index: entry.index, mappingIds: entry.mappingIds }))
        if (subject.furnitureId && furnitureDeleted(subject.furnitureId)) targets.push({ kind: 'supplemental', mappingId: subject.furnitureId })
        void report(async () => { await Promise.all(targets.map(target => applyEdit(target, 'restore'))) })
      }
    }
    // A box is shown as deleted only when nothing of its paragraph is still shown.
    const deleted = new Set([...(markdownEdits?.blocks.filter(block => block.deleted).flatMap(block => block.mappingIds) ?? [])
      .filter(id => !originalBlocks.some(block => block.role === 'content' && block.mappingIds.includes(id))),
    ...(markdownEdits?.supplementalDeleted.map(item => item.mappingId) ?? [])])
    const pdf: PdfBlockMenu = { boxed, deleted, items: id => items(fromMapping(id)), onSelect: (key, id) => select(key, fromMapping(id)) }
    const markdown: MarkdownBlockMenu = { items: (block, figures) => items(fromBlock(block, figures)), onSelect: (key, block, figures) => select(key, fromBlock(block, figures)) }
    return { pdf, markdown }
  }, [addToChat, applyEdit, contentMappingIds, figureChat, mappings, markdownEdits, messageApi, openFigurePdf, originalBlocks, props.documentId, queryClient, translatedBlocks, translationAvailable])
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
          originalBaseBlocks: readerBase.original,
          translatedBaseBlocks: translatedBase.blocks,
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
          onAddToChat: addToChat,
          blockEditing,
          pdfBlockMenu: blockMenus.pdf,
          markdownBlockMenu: blockMenus.markdown,
          blockMove: viewMoves,
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
