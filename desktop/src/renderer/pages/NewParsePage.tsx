import React from 'react'
import { CloudUploadOutlined, FilePdfOutlined, InboxOutlined } from '@ant-design/icons'
import { Alert, Button, Checkbox, Modal, Select, Space, Tag, message } from 'antd'
import { MAX_PDF_BYTES, PROVIDER_LABELS } from '@shared/constants'
import type { AppSettings, ParserModel, SelectedPdf, TranslationProviderId } from '@shared/types'
import ParticleLakeBackground from '../components/ParticleLakeBackground'

export default function NewParsePage(props: {
  settings: AppSettings
  onCreated(): void
  onOpenSettings(): void
}): React.JSX.Element {
  const [files, setFiles] = React.useState<SelectedPdf[]>([])
  const [parserModel, setParserModel] = React.useState<ParserModel>(props.settings.parserModel)
  const [provider, setProvider] = React.useState<TranslationProviderId>(props.settings.translationProvider)
  const [createDuplicates, setCreateDuplicates] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const [dragging, setDragging] = React.useState(false)
  const [messageApi, contextHolder] = message.useMessage()

  const chooseFiles = React.useCallback(async () => setFiles(await window.mineru.choosePdfs()), [])
  const onDrop = React.useCallback(async (event: React.DragEvent) => {
    event.preventDefault()
    setDragging(false)
    const dropped = [...event.dataTransfer.files].filter((file) => file.name.toLowerCase().endsWith('.pdf'))
    if (dropped.length > 0) setFiles(await window.mineru.inspectDroppedPdfs(dropped))
  }, [])

  const start = React.useCallback(async () => {
    setSubmitting(true)
    try {
      const created = await window.mineru.createTasks({ files, parserModel, translationProvider: provider, createDuplicates })
      if (created.length === 0) {
        messageApi.warning('没有创建任务；重复文件可勾选“仍创建新任务”')
        return
      }
      messageApi.success(`已创建 ${created.length} 个任务`)
      props.onCreated()
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : String(error))
    } finally {
      setSubmitting(false)
    }
  }, [createDuplicates, files, messageApi, parserModel, props.onCreated, provider])

  const duplicateCount = files.filter((file) => file.duplicateTask).length
  const oversizedFiles = files.filter((file) => file.size > MAX_PDF_BYTES)

  return (
    <section className="page new-parse-page">
      {contextHolder}
      <ParticleLakeBackground />
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
          onDrop={(event) => void onDrop(event)}
        >
          <span className="visually-hidden">可将一个或多个 PDF 文件拖放到此区域</span>
          <InboxOutlined className="upload-icon" aria-hidden="true" />
          <Button type="primary" size="large" icon={<CloudUploadOutlined />} onClick={() => void chooseFiles()}>
            {dragging ? '松开以添加 PDF' : '选择 PDF'}
          </Button>
        </div>

        {!props.settings.hasParserToken ? (
          <Alert
            className="token-required"
            type="warning"
            showIcon
            message="需要先配置解析 API Token"
            description={<Button type="link" onClick={props.onOpenSettings}>前往系统设置</Button>}
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
        okButtonProps={{ disabled: !props.settings.hasParserToken || oversizedFiles.length > 0 }}
        onOk={() => void start()}
        onCancel={() => setFiles([])}
      >
        <div className="selected-files">
          {files.map((file) => (
            <div className="selected-file" key={file.path}>
              <FilePdfOutlined />
              <span className="selected-name">{file.name}</span>
              <small>{formatBytes(file.size)}</small>
              {file.duplicateTask ? <Tag color="warning">已有任务</Tag> : null}
              {file.size > MAX_PDF_BYTES ? <Tag color="error">超过 200MB</Tag> : null}
            </div>
          ))}
        </div>
        {duplicateCount > 0 ? (
          <Alert
            type="warning"
            showIcon
            message={`检测到 ${duplicateCount} 个重复文件`}
            description={<Checkbox checked={createDuplicates} onChange={(event) => setCreateDuplicates(event.target.checked)}>仍为重复文件创建新任务</Checkbox>}
          />
        ) : null}
        {oversizedFiles.length > 0 ? <Alert type="error" showIcon message="解析 API 不接受超过 200MB 的单个文件" /> : null}
        <Space className="confirm-options" size="large">
          <label>
            <span>解析模型</span>
            <Select<ParserModel>
              value={parserModel}
              onChange={setParserModel}
              options={[{ value: 'vlm', label: '视觉模型' }, { value: 'pipeline', label: '标准模型' }]}
            />
          </label>
          <label>
            <span>翻译模型</span>
            <Select<TranslationProviderId>
              value={provider}
              onChange={setProvider}
              options={Object.entries(PROVIDER_LABELS).map(([value, label]) => ({ value: value as TranslationProviderId, label }))}
            />
          </label>
        </Space>
      </Modal>
    </section>
  )
}

function formatBytes(value: number): string {
  return value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`
}
