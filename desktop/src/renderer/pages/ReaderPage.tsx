import React from 'react'
import { ArrowLeftOutlined, CopyOutlined, DownloadOutlined, FolderOpenOutlined } from '@ant-design/icons'
import { Button, Dropdown, Space, Spin, Tag, Typography, message } from 'antd'
import { buildReaderDocumentBlocks } from '@shared/readerDocument'
import type { BlockSelection, DocumentPayload } from '@shared/types'
import PdfPane from '../components/PdfPane'
import ReaderTextPane, { type ReaderTab } from '../components/ReaderTextPane'

export default function ReaderPage(props: { taskId: string; onBack(): void }): React.JSX.Element {
  const [document, setDocument] = React.useState<DocumentPayload | null>(null)
  const [tab, setTab] = React.useState<ReaderTab>('original')
  const [selection, setSelection] = React.useState<BlockSelection | null>(null)
  const [jsonQuery, setJsonQuery] = React.useState('')
  const lastTerminalStatus = React.useRef<string | null>(null)
  const [messageApi, contextHolder] = message.useMessage()
  const [, startTransition] = React.useTransition()

  const load = React.useCallback(async () => setDocument(await window.mineru.getDocument(props.taskId)), [props.taskId])
  React.useEffect(() => { void load() }, [load])
  React.useEffect(() => {
    setTab('original')
    setSelection(null)
    setJsonQuery('')
    lastTerminalStatus.current = null
  }, [props.taskId])
  React.useEffect(() => window.mineru.onTasksChanged((tasks) => {
    const task = tasks.find((item) => item.id === props.taskId)
    if (task && ['completed', 'partial', 'failed'].includes(task.status) && lastTerminalStatus.current !== task.status) {
      lastTerminalStatus.current = task.status
      void load()
    }
  }), [load, props.taskId])

  const readerBlocks = React.useMemo(
    () => document
      ? buildReaderDocumentBlocks(
          document.markdown,
          document.translatedMarkdown,
          document.translatedBlocks,
          document.mappings
        )
      : { original: [], translated: [] },
    [document]
  )
  const selectBlock = React.useCallback((next: BlockSelection) => setSelection(next), [])
  const changeTab = React.useCallback((next: ReaderTab) => {
    startTransition(() => setTab(next))
  }, [startTransition])

  const copyCurrent = React.useCallback(async () => {
    if (!document) return
    const value = tab === 'original' ? document.markdown : tab === 'translated' ? document.translatedMarkdown : document.layoutJson
    await navigator.clipboard.writeText(value)
    messageApi.success('已复制')
  }, [document, messageApi, tab])

  if (!document) return <div className="reader-loading"><Spin size="large" /></div>

  const translatedReady = Boolean(document.translatedMarkdown)

  return (
    <section className="reader-page">
      {contextHolder}
      <header className="reader-header">
        <Space><Button type="text" icon={<ArrowLeftOutlined />} onClick={props.onBack} /><Typography.Text strong ellipsis className="reader-title">{document.task.name}</Typography.Text><Tag>{document.task.parserModel === 'vlm' ? 'MinerU VLM' : 'MinerU'}</Tag></Space>
        <Space>
          <Button type="text" icon={<FolderOpenOutlined />} onClick={() => void window.mineru.openOutputDirectory(document.task.id)} aria-label="打开输出目录" />
          <Button type="text" icon={<CopyOutlined />} onClick={() => void copyCurrent()} aria-label="复制当前内容" />
          <Dropdown menu={{ items: [{ key: 'current', label: '另存当前 Markdown' }, { key: 'zip', label: '另存完整结果 ZIP' }], onClick: ({ key }) => void window.mineru.saveAs({ taskId: document.task.id, kind: key === 'zip' ? 'result-zip' : tab === 'translated' ? 'translated-markdown' : 'original-markdown' }) }}>
            <Button type="text" icon={<DownloadOutlined />} aria-label="另存" />
          </Dropdown>
        </Space>
      </header>
      <div className="reader-split">
        <PdfPane url={document.pdfUrl} mappings={document.mappings} selection={selection} onSelect={selectBlock} />
        <ReaderTextPane
          key={document.task.id}
          tab={tab}
          onTabChange={changeTab}
          originalBlocks={readerBlocks.original}
          translatedBlocks={readerBlocks.translated}
          translatedReady={translatedReady}
          taskStatus={document.task.status}
          layoutJson={document.layoutJson}
          jsonQuery={jsonQuery}
          onJsonQueryChange={setJsonQuery}
          assetBaseUrl={document.assetBaseUrl}
          selection={selection}
          onSelect={selectBlock}
        />
      </div>
    </section>
  )
}
