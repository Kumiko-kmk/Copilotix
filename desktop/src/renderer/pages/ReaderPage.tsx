import React from 'react'
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
import type { BlockSelection, ReaderAnnotation, ReaderAnnotationView } from '@shared/types'
import { IpcClientError } from '@shared/ipc'
import { buildAnnotationDiff, replayAnnotationDiff } from '../annotationMutations'
import PdfPane from '../components/PdfPane'
import ReaderTextPane, { type ReaderTab } from '../components/ReaderTextPane'

export default function ReaderPage(props: { documentId: string; onBack(): void }): React.JSX.Element {
  const queryClient = useQueryClient()
  const [tab, setTab] = React.useState<ReaderTab>('original')
  const [selection, setSelection] = React.useState<BlockSelection | null>(null)
  const [jsonQuery, setJsonQuery] = React.useState('')
  const [messageApi, contextHolder] = message.useMessage()
  const [, startTransition] = React.useTransition()

  const documentQuery = useQuery<DocumentDetails>({
    queryKey: ['document', props.documentId],
    queryFn: () => window.copilotix.getDocument(props.documentId)
  })
  const originalAnnotations = useAnnotationQuery(props.documentId, 'original')
  const translatedAnnotations = useAnnotationQuery(props.documentId, 'translated')
  const document = documentQuery.data
  const snapshots = { original: originalAnnotations.data, translated: translatedAnnotations.data }
  const annotations = [
    ...(snapshots.original?.annotations ?? []).map(toLegacyAnnotation),
    ...(snapshots.translated?.annotations ?? []).map(toLegacyAnnotation)
  ]

  React.useEffect(() => {
    setTab('original')
    setSelection(null)
    setJsonQuery('')
  }, [props.documentId])

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
  const changeTab = React.useCallback((next: ReaderTab) => {
    startTransition(() => setTab(next))
  }, [startTransition])

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
          <Button type="text" icon={<CopyOutlined />} onClick={() => void copyCurrent(document, tab, messageApi)} aria-label="复制当前内容" />
          <Dropdown menu={{ items: [{ key: 'current', label: '另存当前 Markdown' }, { key: 'zip', label: '另存完整结果 ZIP' }], onClick: ({ key }) => void saveDocument(document.summary.id, key, tab, messageApi) }}>
            <Button type="text" icon={<DownloadOutlined />} aria-label="另存" />
          </Dropdown>
        </Space>
      </header>
      <div className="reader-split">
        <PdfPane url={document.pdfUrl} mappings={document.mappings} selection={selection} onSelect={selectBlock} />
        <ReaderTextPane
          key={document.summary.id}
          tab={tab}
          onTabChange={changeTab}
          originalBlocks={originalBlocks}
          translatedBlocks={translatedBlocks}
          translatedReady={translatedReady}
          taskStatus={document.summary.workflow.status}
          layoutJson={document.layoutJson}
          jsonQuery={jsonQuery}
          onJsonQueryChange={setJsonQuery}
          assetBaseUrl={document.assetBaseUrl}
          pdfUrl={document.pdfUrl}
          mappings={document.mappings}
          taskId={document.summary.id}
          annotations={annotations}
          onReplaceAnnotations={replaceAnnotations}
          selection={selection}
          onSelect={selectBlock}
        />
      </div>
    </section>
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
  tab: ReaderTab,
  messageApi: ReturnType<typeof message.useMessage>[0]
): Promise<void> {
  const value = tab === 'original' ? document.markdown : tab === 'translated' ? document.translatedMarkdown : document.layoutJson
  await navigator.clipboard.writeText(value)
  messageApi.success('已复制')
}

async function saveDocument(
  documentId: string,
  key: string,
  tab: ReaderTab,
  messageApi: ReturnType<typeof message.useMessage>[0]
): Promise<void> {
  const result = await window.copilotix.saveDocumentAs({
    documentId,
    kind: key === 'zip' ? 'result-zip' : tab === 'translated' ? 'translated-markdown' : 'original-markdown'
  })
  if (result.saved) messageApi.success('已保存')
}
