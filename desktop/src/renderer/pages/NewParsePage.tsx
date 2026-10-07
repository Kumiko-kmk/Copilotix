import React from 'react'
import { FilePdfOutlined } from '@ant-design/icons'
import { Alert, Button, Checkbox, Modal, Tag, message } from 'antd'
import { MAX_PDF_BYTES, MAX_PDF_PAGES } from '@shared/constants'
import type { AppSettings } from '@shared/types'
import type { DocumentSummary } from '@shared/ipcSchemas'
import CopilotixWordmark from '../components/CopilotixWordmark'
import { HomeBackdrop, UploadGlyph } from '../components/HomeScene'
import { HomeGreeting, RecentShelf } from '../components/HomeWidgets'

interface PendingPdf {
  file: File
  name: string
  size: number
}

const TUTORIAL_ENTRY_USED_KEY = 'copilotix:tutorial:entry-used:v1'

export default function NewParsePage(props: {
  settings: AppSettings
  documents?: DocumentSummary[]
  onCreated(): void
  onOpenSettings(): void
  onOpenTutorial(): void
  onOpenDocument?(documentId: string): void
  onOpenTasks?(): void
}): React.JSX.Element {
  const [files, setFiles] = React.useState<PendingPdf[]>([])
  const [tutorialEntryUsed, setTutorialEntryUsed] = React.useState(() => window.localStorage.getItem(TUTORIAL_ENTRY_USED_KEY) === '1')
  const [useOriginalFilename, setUseOriginalFilename] = React.useState(false)
  const [skipDuplicates, setSkipDuplicates] = React.useState(true)
  const [submitting, setSubmitting] = React.useState(false)
  const [dragging, setDragging] = React.useState(false)
  const pageRef = React.useRef<HTMLElement>(null)
  const uploadRef = React.useRef<HTMLDivElement>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const dragDepthRef = React.useRef(0)
  const [messageApi, contextHolder] = message.useMessage()

  const setPdfFiles = React.useCallback((nextFiles: File[]): void => {
    setFiles(nextFiles
      .filter((file) => file.name.toLowerCase().endsWith('.pdf'))
      .map((file) => ({ file, name: file.name, size: file.size })))
  }, [])
  const chooseFiles = React.useCallback(() => inputRef.current?.click(), [])

  React.useEffect(() => {
    const containsFiles = (event: DragEvent): boolean => Array.from(event.dataTransfer?.types ?? []).includes('Files')
    const onDragEnter = (event: DragEvent): void => {
      if (!containsFiles(event)) return
      event.preventDefault()
      dragDepthRef.current += 1
      setDragging(true)
    }
    const onDragOver = (event: DragEvent): void => {
      if (!containsFiles(event)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }
    const onDragLeave = (event: DragEvent): void => {
      if (!containsFiles(event)) return
      event.preventDefault()
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
      if (dragDepthRef.current === 0) setDragging(false)
    }
    const onDrop = (event: DragEvent): void => {
      if (!containsFiles(event)) return
      event.preventDefault()
      dragDepthRef.current = 0
      setDragging(false)
      setPdfFiles(Array.from(event.dataTransfer?.files ?? []))
    }
    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [setPdfFiles])

  React.useEffect(() => {
    const page = pageRef.current
    if (!page || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    let frame = 0
    const onPointerMove = (event: PointerEvent): void => {
      if (frame) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        page.style.setProperty('--px', (event.clientX / window.innerWidth * 2 - 1).toFixed(3))
        page.style.setProperty('--py', (event.clientY / window.innerHeight * 2 - 1).toFixed(3))
      })
    }
    window.addEventListener('pointermove', onPointerMove)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [])

  const start = React.useCallback(async () => {
    setSubmitting(true)
    try {
      const created = await window.copilotix.importDocuments(
        { createDuplicates: !skipDuplicates, useOriginalFilename },
        files.map(({ file }) => file)
      )
      if (created.length === 0) {
        messageApi.warning('没有创建任务；所选 PDF 已存在于论文库')
        return
      }
      messageApi.success(`已创建 ${created.length} 个任务`)
      setFiles([])
      props.onCreated()
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : String(error))
    } finally {
      setSubmitting(false)
    }
  }, [files, messageApi, props.onCreated, skipDuplicates, useOriginalFilename])

  const oversizedFiles = files.filter((file) => file.size > MAX_PDF_BYTES)

  return (
    <section ref={pageRef} className={`page new-parse-page${dragging ? ' is-dragging' : ''}`}>
      {contextHolder}
      <HomeBackdrop />
      <div className="new-parse-hero">
        <CopilotixWordmark />
        <div className="new-parse-heading">
          <HomeGreeting />
          <h1>今天想读些什么？</h1>
        </div>
        <div className="new-parse-content">
        <div
          ref={uploadRef}
          className={dragging ? 'upload-entry dragging' : 'upload-entry'}
          onPointerMove={(event) => {
            const entry = uploadRef.current
            if (!entry) return
            const bounds = entry.getBoundingClientRect()
            entry.style.setProperty('--mx', `${event.clientX - bounds.left}px`)
            entry.style.setProperty('--my', `${event.clientY - bounds.top}px`)
          }}
          data-testid="pdf-upload-entry"
          role="region"
          aria-label="文档导入区，当前支持 PDF"
        >
          <span className="upload-halo" aria-hidden="true" />
          <span className="visually-hidden">可将一个或多个 PDF 文件拖放到此窗口</span>
          <div className="upload-entry-copy">
            <UploadGlyph />
            <div className="upload-entry-text">
              <span className="upload-prompt">拖入文档</span>
              <small>当前支持 PDF，单篇最多 {MAX_PDF_PAGES} 页</small>
            </div>
          </div>
          <Button type="primary" size="large" loading={submitting} onClick={chooseFiles}>
            选择文档
          </Button>
          <input
            ref={inputRef}
            className="visually-hidden"
            type="file"
            accept="application/pdf,.pdf"
            multiple
            aria-hidden="true"
            tabIndex={-1}
            onChange={(event) => setPdfFiles([...event.target.files ?? []])}
          />
        </div>

        </div>
        {!tutorialEntryUsed ? <button type="button" className="tutorial-entry" onClick={() => {
          window.localStorage.setItem(TUTORIAL_ENTRY_USED_KEY, '1')
          setTutorialEntryUsed(true)
          props.onOpenTutorial()
        }}>第一次使用？从内置论文开始新手教程 <span aria-hidden="true">→</span></button> : null}
        {props.documents && props.onOpenDocument ? (
          <RecentShelf documents={props.documents} onOpen={props.onOpenDocument} onViewAll={() => props.onOpenTasks?.()} />
        ) : null}
      </div>

      <div className="drop-veil" aria-hidden="true">
        <svg className="drop-veil-frame" preserveAspectRatio="none">
          <rect x="1.5" y="1.5" rx="22" ry="22" />
        </svg>
        <div className="drop-veil-message">
          <UploadGlyph />
          <strong>松手，开始导入</strong>
          <small>仅接收 PDF 文件</small>
        </div>
      </div>

      <Modal
        title="确认解析任务"
        open={files.length > 0}
        width={720}
        okText="开始解析"
        confirmLoading={submitting}
        okButtonProps={{ disabled: props.settings.credentials.parser.state === 'missing' || props.settings.credentials.parser.state === 'invalid' || oversizedFiles.length > 0 }}
        footer={(_, { OkBtn }) => <OkBtn />}
        onOk={() => void start()}
        onCancel={() => setFiles([])}
      >
        {props.settings.credentials.parser.state === 'missing' ? (
          <Alert
            className="token-required"
            type="warning"
            showIcon
            message="需要先配置解析 API Token"
            description={<Button type="link" onClick={props.onOpenSettings}>前往系统设置</Button>}
          />
        ) : null}
        {props.settings.credentials.parser.state === 'invalid' ? (
          <Alert
            className="token-required"
            type="error"
            showIcon
            message="Parser API Token 验证失败"
            description={<Button type="link" onClick={props.onOpenSettings}>前往系统设置重新验证</Button>}
          />
        ) : null}
        <div className="import-options" role="group" aria-label="导入选项">
          <Checkbox checked={useOriginalFilename} onChange={(event) => setUseOriginalFilename(event.target.checked)}>使用原文件名</Checkbox>
          <Checkbox checked={skipDuplicates} onChange={(event) => setSkipDuplicates(event.target.checked)}>跳过重复文件</Checkbox>
        </div>
        <div className="selected-files">
          {files.map((file) => (
            <div className="selected-file" key={`${file.name}:${file.size}:${file.file.lastModified}`}>
              <FilePdfOutlined />
              <span className="selected-name">{file.name}</span>
              <small>{formatBytes(file.size)}</small>
              {file.size > MAX_PDF_BYTES ? <Tag color="error">超过 200MB</Tag> : null}
            </div>
          ))}
        </div>
        {oversizedFiles.length > 0 ? <Alert type="error" showIcon message="解析 API 不接受超过 200MB 的单个文件" /> : null}
      </Modal>
    </section>
  )
}

function formatBytes(value: number): string {
  return value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`
}
