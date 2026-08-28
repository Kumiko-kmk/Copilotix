import React from 'react'
import { CloudUploadOutlined, FilePdfOutlined, InboxOutlined } from '@ant-design/icons'
import { Alert, Button, Checkbox, Modal, Select, Space, Tag, Typography, message } from 'antd'
import { PROVIDER_LABELS } from '@shared/constants'
import type { AppSettings, ParserModel, SelectedPdf, TranslationProviderId } from '@shared/types'

export default function NewParsePage(props: {
  settings: AppSettings
  onCreated(): void
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

  return (
    <section className="page new-parse-page">
      {contextHolder}
      <header className="page-header compact-header">
        <div>
          <Typography.Title level={2}>智能解析</Typography.Title>
          <Typography.Text type="secondary">上传 PDF，经 MinerU 解析后自动生成简体中文译文</Typography.Text>
        </div>
      </header>
      <div
        className={dragging ? 'upload-entry dragging' : 'upload-entry'}
        onDragEnter={(event) => { event.preventDefault(); setDragging(true) }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => void onDrop(event)}
      >
        <InboxOutlined className="upload-icon" />
        <h2>拖入 PDF 文件</h2>
        <p>支持批量选择，每份 PDF 会建立独立任务</p>
        <Button type="primary" size="large" icon={<CloudUploadOutlined />} onClick={() => void chooseFiles()}>
          选择 PDF
        </Button>
      </div>

      <Modal
        title="确认解析任务"
        open={files.length > 0}
        width={720}
        okText="开始解析"
        cancelText="重新选择"
        confirmLoading={submitting}
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
        <Space className="confirm-options" size="large">
          <label>
            <span>解析模型</span>
            <Select<ParserModel>
              value={parserModel}
              onChange={setParserModel}
              options={[{ value: 'hybrid-engine', label: 'MinerU VLM' }, { value: 'pipeline', label: 'MinerU' }]}
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
