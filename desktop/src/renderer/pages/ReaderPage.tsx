import React from 'react'
import { ArrowLeftOutlined, CopyOutlined, DownloadOutlined, FolderOpenOutlined } from '@ant-design/icons'
import { Button, Dropdown, Empty, Input, Segmented, Space, Spin, Tag, Typography, message } from 'antd'
import type { DocumentPayload } from '@shared/types'
import MarkdownPane from '../components/MarkdownPane'
import PdfPane from '../components/PdfPane'

type ReaderTab = 'original' | 'translated' | 'json'

export default function ReaderPage(props: { taskId: string; onBack(): void }): React.JSX.Element {
  const [document, setDocument] = React.useState<DocumentPayload | null>(null)
  const [tab, setTab] = React.useState<ReaderTab>('original')
  const [activeBlockId, setActiveBlockId] = React.useState<string | null>(null)
  const [jsonQuery, setJsonQuery] = React.useState('')
  const lastTerminalStatus = React.useRef<string | null>(null)
  const [messageApi, contextHolder] = message.useMessage()

  const load = React.useCallback(async () => setDocument(await window.mineru.getDocument(props.taskId)), [props.taskId])
  React.useEffect(() => { void load() }, [load])
  React.useEffect(() => window.mineru.onTasksChanged((tasks) => {
    const task = tasks.find((item) => item.id === props.taskId)
    if (task && ['completed', 'partial', 'failed'].includes(task.status) && lastTerminalStatus.current !== task.status) {
      lastTerminalStatus.current = task.status
      void load()
    }
  }), [load, props.taskId])

  const copyCurrent = React.useCallback(async () => {
    if (!document) return
    const value = tab === 'original' ? document.markdown : tab === 'translated' ? document.translatedMarkdown : document.layoutJson
    await navigator.clipboard.writeText(value)
    messageApi.success('已复制')
  }, [document, messageApi, tab])

  if (!document) return <div className="reader-loading"><Spin size="large" /></div>

  const translatedReady = Boolean(document.translatedMarkdown)
  const jsonContent = jsonQuery ? highlightJsonSearch(document.layoutJson, jsonQuery) : document.layoutJson

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
        <PdfPane url={document.pdfUrl} mappings={document.mappings} activeBlockId={activeBlockId} onActiveBlock={setActiveBlockId} />
        <div className="text-pane">
          <div className="text-toolbar">
            <Segmented<ReaderTab>
              value={tab}
              onChange={setTab}
              options={[{ value: 'original', label: 'Markdown' }, { value: 'translated', label: 'Markdown（中文）' }, { value: 'json', label: 'JSON' }]}
            />
            {tab === 'translated' ? <Tag color={translationColor(document.task.status)}>{translationLabel(document.task.status)}</Tag> : null}
            {tab === 'json' ? <Input allowClear size="small" placeholder="搜索 JSON" value={jsonQuery} onChange={(event) => setJsonQuery(event.target.value)} /> : null}
          </div>
          {tab === 'original' ? <MarkdownPane markdown={document.markdown} mappings={document.mappings} assetBaseUrl={document.assetBaseUrl} activeBlockId={activeBlockId} onActiveBlock={setActiveBlockId} /> : null}
          {tab === 'translated' && translatedReady ? <MarkdownPane markdown={document.translatedMarkdown} mappings={document.mappings} assetBaseUrl={document.assetBaseUrl} activeBlockId={activeBlockId} onActiveBlock={setActiveBlockId} /> : null}
          {tab === 'translated' && !translatedReady ? <Empty className="translation-empty" description={translationLabel(document.task.status)} /> : null}
          {tab === 'json' ? <pre className="json-view">{jsonContent}</pre> : null}
        </div>
      </div>
    </section>
  )
}

function translationLabel(status: DocumentPayload['task']['status']): string {
  if (status === 'completed') return '翻译完成'
  if (status === 'partial') return '部分翻译完成，可重试失败区块'
  if (status === 'failed') return '任务失败'
  if (status === 'translating') return '正在翻译'
  return '等待解析完成'
}

function translationColor(status: DocumentPayload['task']['status']): string {
  if (status === 'completed') return 'success'
  if (status === 'partial') return 'warning'
  if (status === 'failed') return 'error'
  return 'processing'
}

function highlightJsonSearch(json: string, query: string): string {
  const index = json.toLowerCase().indexOf(query.toLowerCase())
  if (index < 0) return json
  const start = Math.max(0, index - 500)
  const end = Math.min(json.length, index + query.length + 1_500)
  return `${start > 0 ? '…\n' : ''}${json.slice(start, end)}${end < json.length ? '\n…' : ''}`
}
