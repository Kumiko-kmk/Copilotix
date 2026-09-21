import React from 'react'
import { FileOutlined, FilePdfOutlined } from '@ant-design/icons'
import { Alert, Button, Checkbox, Modal, Tag, message } from 'antd'
import { MAX_PDF_BYTES } from '@shared/constants'
import type { AppSettings } from '@shared/types'

interface PendingPdf {
  file: File
  name: string
  size: number
}

const WORDMARK_GLYPHS = [
  ['..#####', '.######', '###....', '##.....', '##.....', '##.....', '##.....', '###....', '.######', '..#####'],
  ['..####..', '.##..##.', '##....##', '##....##', '##....##', '##....##', '##....##', '##....##', '.##..##.', '..####..'],
  ['######..', '##...##.', '##....##', '##....##', '##...##.', '######..', '##......', '##......', '##......', '##......'],
  ['########', '.######.', '...##...', '...##...', '...##...', '...##...', '...##...', '...##...', '.######.', '########'],
  ['##......', '##......', '##......', '##......', '##......', '##......', '##......', '##......', '########', '########'],
  ['..####..', '.##..##.', '##....##', '##....##', '##....##', '##....##', '##....##', '##....##', '.##..##.', '..####..'],
  ['########', '.######.', '...##...', '...##...', '...##...', '...##...', '...##...', '...##...', '...##...', '...##...'],
  ['########', '.######.', '...##...', '...##...', '...##...', '...##...', '...##...', '...##...', '.######.', '########'],
  ['##....##', '##....##', '.##..##.', '..####..', '...##...', '...##...', '..####..', '.##..##.', '##....##', '##....##']
] as const

const WORDMARK_LETTERS = 'COPILOTIX'

function CopilotixWordmark(): React.JSX.Element {
  const rows = Array.from({ length: 10 }, (_, row) => WORDMARK_GLYPHS
    .map((glyph, index) => {
      const cells = glyph[row]!.replaceAll('#', WORDMARK_LETTERS[index]!).replaceAll('.', ' ')
      return index === 0 ? `${cells} ` : cells
    })
    .join('  '))

  return (
    <div className="copilotix-wordmark" role="img" aria-label="COPILOTIX">
      {rows.map((row, index) => <span aria-hidden="true" key={index}>{row}</span>)}
    </div>
  )
}

export default function NewParsePage(props: {
  settings: AppSettings
  onCreated(): void
  onOpenSettings(): void
}): React.JSX.Element {
  const [files, setFiles] = React.useState<PendingPdf[]>([])
  const [useOriginalFilename, setUseOriginalFilename] = React.useState(false)
  const [skipDuplicates, setSkipDuplicates] = React.useState(true)
  const [submitting, setSubmitting] = React.useState(false)
  const [dragging, setDragging] = React.useState(false)
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
    <section className="page new-parse-page">
      {contextHolder}
      <div className="new-parse-hero">
        <CopilotixWordmark />
        <h1>今天想读些什么？</h1>
        <div className="new-parse-content">
        <div
          className={dragging ? 'upload-entry dragging' : 'upload-entry'}
          data-testid="pdf-upload-entry"
          role="region"
          aria-label="文档导入区，当前支持 PDF"
        >
          <span className="visually-hidden">可将一个或多个 PDF 文件拖放到此窗口</span>
          <div className="upload-entry-copy">
            <FileOutlined className="upload-icon" aria-hidden="true" />
            <div className="upload-entry-text">
              <span className="upload-prompt">拖入文档</span>
              <small>当前支持 PDF</small>
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
