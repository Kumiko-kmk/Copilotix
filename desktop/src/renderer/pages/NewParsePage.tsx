import React from 'react'
import { CloudUploadOutlined, FilePdfOutlined, InboxOutlined } from '@ant-design/icons'
import { Alert, Button, Checkbox, Modal, Select, Space, Tag, message } from 'antd'
import { MAX_PDF_BYTES, PROVIDER_LABELS } from '@shared/constants'
import type { AppSettings, TranslationProviderId } from '@shared/types'

interface PendingPdf {
  file: File
  name: string
  size: number
}

export default function NewParsePage(props: {
  settings: AppSettings
  onCreated(): void
  onOpenSettings(): void
}): React.JSX.Element {
  const [files, setFiles] = React.useState<PendingPdf[]>([])
  const [provider, setProvider] = React.useState<TranslationProviderId>(props.settings.translationProvider)
  const [createDuplicates, setCreateDuplicates] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const [dragging, setDragging] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [messageApi, contextHolder] = message.useMessage()

  const setPdfFiles = React.useCallback((nextFiles: File[]): void => {
    setFiles(nextFiles
      .filter((file) => file.name.toLowerCase().endsWith('.pdf'))
      .map((file) => ({ file, name: file.name, size: file.size })))
  }, [])
  const chooseFiles = React.useCallback(() => inputRef.current?.click(), [])
  const onDrop = React.useCallback((event: React.DragEvent) => {
    event.preventDefault()
    setDragging(false)
    setPdfFiles([...event.dataTransfer.files])
  }, [setPdfFiles])

  const start = React.useCallback(async () => {
    setSubmitting(true)
    try {
      const created = await window.copilotix.importDocuments(
        { translationProvider: provider, createDuplicates },
        files.map(({ file }) => file)
      )
      if (created.length === 0) {
        messageApi.warning('没有创建任务；重复文件可勾选“仍创建新任务”')
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
  }, [createDuplicates, files, messageApi, props.onCreated, provider])

  const oversizedFiles = files.filter((file) => file.size > MAX_PDF_BYTES)

  return (
    <section className="page new-parse-page">
      {contextHolder}
      <div className="new-parse-content">
        <div
          className={dragging ? 'upload-entry dragging' : 'upload-entry'}
          data-testid="pdf-upload-entry"
          role="region"
          aria-label="PDF 文件上传区"
          onDragEnter={(event) => { event.preventDefault(); setDragging(true) }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false)
          }}
          onDrop={onDrop}
        >
          <span className="visually-hidden">可将一个或多个 PDF 文件拖放到此区域</span>
          <InboxOutlined className="upload-icon" aria-hidden="true" />
          <Button type="primary" size="large" icon={<CloudUploadOutlined />} onClick={chooseFiles}>
            {dragging ? '松开以添加 PDF' : '选择 PDF'}
          </Button>
          <input
            ref={inputRef}
            className="visually-hidden"
            type="file"
            accept="application/pdf,.pdf"
            multiple
            onChange={(event) => setPdfFiles([...event.target.files ?? []])}
          />
        </div>

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
      </div>

      <Modal
        title="确认解析任务"
        open={files.length > 0}
        width={720}
        okText="开始解析"
        cancelText="重新选择"
        confirmLoading={submitting}
        okButtonProps={{ disabled: props.settings.credentials.parser.state === 'missing' || props.settings.credentials.parser.state === 'invalid' || oversizedFiles.length > 0 }}
        onOk={() => void start()}
        onCancel={() => setFiles([])}
      >
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
        <Alert
          type="info"
          showIcon
          message="导入时会自动跳过已有相同文件"
          description={<Checkbox checked={createDuplicates} onChange={(event) => setCreateDuplicates(event.target.checked)}>仍为重复文件创建新任务</Checkbox>}
        />
        {oversizedFiles.length > 0 ? <Alert type="error" showIcon message="解析 API 不接受超过 200MB 的单个文件" /> : null}
        <Space className="confirm-options" size="large">
          <label>
            <span>翻译模型</span>
            <Select<TranslationProviderId> value={provider} onChange={setProvider} options={Object.entries(PROVIDER_LABELS).map(([value, label]) => ({ value: value as TranslationProviderId, label }))} />
          </label>
        </Space>
      </Modal>
    </section>
  )
}

function formatBytes(value: number): string {
  return value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`
}
