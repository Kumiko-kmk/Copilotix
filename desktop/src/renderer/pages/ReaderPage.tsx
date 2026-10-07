import React from 'react'
import { usePaperChat, type PaperChatTurn } from '../usePaperChat'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeftOutlined, CopyOutlined, DownloadOutlined, FolderOpenOutlined } from '@ant-design/icons'
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
import { useReaderViews, type ReaderChatOptions, type ReaderViewsInput } from '../components/ReaderViews'
import {
  activeSyncedViews,
  findGroup,
  groupOfView,
  listGroups,
  loadReaderLayout,
  saveReaderLayout,
  type ReaderLayout,
  type ReaderViewId
} from '../readerLayout'

export default function ReaderPage(props: { documentId: string; onBack(): void; onOpenSettings(): void }): React.JSX.Element {
  const queryClient = useQueryClient()
  const chat = usePaperChat(props.documentId)
  const [layout, setLayout] = React.useState<ReaderLayout>(loadReaderLayout)
  const [focusedGroupId, setFocusedGroupId] = React.useState<string | null>(null)
  const [revealReadingNonce, setRevealReadingNonce] = React.useState(0)
  const [selection, setSelection] = React.useState<BlockSelection | null>(null)
  const [messageApi, contextHolder] = message.useMessage()

  const documentQuery = useQuery<DocumentDetails>({
    queryKey: ['document', props.documentId],
    queryFn: () => window.copilotix.getDocument(props.documentId)
  })
  const originalAnnotations = useAnnotationQuery(props.documentId, 'original')
  const translatedAnnotations = useAnnotationQuery(props.documentId, 'translated')
  const document = documentQuery.data
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
  const originalBlocks = React.useMemo(
    () => buildOriginalReaderBlocks(markdown, mappings),
    [markdown, mappings]
  )
  const translatedBlocks = React.useMemo(
    () => buildTranslatedReaderBlocks(markdown, translatedMarkdown, translatedSourceBlocks, mappings),
    [markdown, mappings, translatedMarkdown, translatedSourceBlocks]
  )
  const selectBlock = React.useCallback((next: BlockSelection) => setSelection(next), [])

  // Adding a selection never leaves the current reader; the chat tab shows the count.
  const { addSelection } = chat
  const addToChat = React.useCallback((selection: ReaderChatSelection) => {
    void addSelection(selection).then((failure) => {
      if (failure) messageApi.warning({ content: failure, key: 'paper-chat-pin' })
      else messageApi.success({ content: '已加入 AI 问答选区', key: 'paper-chat-pin', duration: 1.5 })
    })
  }, [addSelection, messageApi])
  // A citation scrolls the reading views to its block; if none is on screen, the workbench shows one.
  const openCitation = React.useCallback((next: BlockSelection) => {
    selectBlock(next)
    setRevealReadingNonce((value) => value + 1)
  }, [selectBlock])
  const chatOptions = React.useMemo<ReaderChatOptions>(() => ({
    controller: chat,
    onOpenSettings: props.onOpenSettings,
    onCitation: openCitation
  }), [chat, openCitation, props.onOpenSettings])

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
    <section className="reader-page">
      {contextHolder}
      <header className="reader-header">
        <Space><Button type="text" icon={<ArrowLeftOutlined />} onClick={props.onBack} /><Typography.Text strong ellipsis className="reader-title">{document.summary.displayName}</Typography.Text></Space>
        <Space>
          <Button type="text" icon={<FolderOpenOutlined />} onClick={() => void window.copilotix.openDocumentOutput(document.summary.id)} aria-label="打开输出目录" />
          <Button type="text" icon={<CopyOutlined />} disabled={focusedView === 'pdf'} title={focusedView === 'pdf' ? 'PDF 视图没有可复制的文本' : undefined} onClick={() => void copyCurrent(document, focusedView, chat.turns, messageApi)} aria-label="复制当前内容" />
          <Dropdown menu={{ items: [...(focusedView === 'original' || focusedView === 'translated' ? [{ key: 'current', label: '另存当前 Markdown' }] : []), { key: 'zip', label: '另存完整结果 ZIP' }], onClick: ({ key }) => void saveDocument(document.summary.id, key, focusedView, messageApi) }}>
            <Button type="text" icon={<DownloadOutlined />} aria-label="另存" />
          </Dropdown>
        </Space>
      </header>
      <ReaderWorkspace
        key={document.summary.id}
        layout={layout}
        onLayoutChange={setLayout}
        focusedGroupId={focusedGroupId}
        onFocusGroup={setFocusedGroupId}
        revealReadingNonce={revealReadingNonce}
        views={{
          pdfUrl: document.pdfUrl,
          mappings: document.mappings,
          originalBlocks,
          translatedBlocks,
          translatedReady,
          taskStatus: document.summary.workflow.status,
          assetBaseUrl: document.assetBaseUrl,
          taskId: document.summary.id,
          annotations,
          onReplaceAnnotations: replaceAnnotations,
          selection,
          onSelect: selectBlock,
          onAddToChat: addToChat,
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

async function copyCurrent(
  document: DocumentDetails,
  view: ReaderViewId,
  turns: readonly PaperChatTurn[],
  messageApi: ReturnType<typeof message.useMessage>[0]
): Promise<void> {
  const value = view === 'original' ? document.markdown
    : view === 'translated' ? document.translatedMarkdown
      : view === 'chat' ? chatTranscript(turns)
        : ''
  if (!value) return
  await navigator.clipboard.writeText(value)
  messageApi.success('已复制')
}

/** Questions as quotes, answers verbatim; evidence markers are kept as written. */
export function chatTranscript(turns: readonly PaperChatTurn[]): string {
  return turns
    .filter((turn) => turn.answer.trim())
    .map((turn) => `> ${turn.question.replace(/\n/gu, '\n> ')}\n\n${turn.answer.trim()}`)
    .join('\n\n---\n\n')
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
