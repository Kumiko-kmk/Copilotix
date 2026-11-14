import React from 'react'
import { ArrowRightOutlined, FilePdfOutlined, LoadingOutlined } from '@ant-design/icons'
import { Alert, Button, Checkbox, Modal, Radio, Tag, message } from 'antd'
import { MAX_PDF_BYTES, MAX_PDF_PAGES } from '../contract/pdfLimits'
import { MAX_PDF_CROP_BYTES, type ImportFileOptions } from '../contract/pdfImport'
import { TRANSLATION_PROVIDER_LABELS, executableProviderOrder } from '@features/translation/contract/providerPolicy'
import type { AppSettings } from '@features/settings/contract/settingsTypes'
import type { TranslationProviderId } from '@features/translation/contract/translationTypes'
import type { DocumentSummary } from '../contract/documentSchemas'
import { UploadGlyph } from './home/HomeScene'
import ImportProgress from './home/ImportProgress'
import type { PdfFileInspection } from './pdfInspection'
import { ZoteroImportDialog } from '@features/zotero/renderer'

interface PendingPdf {
  key: string
  file: File
  name: string
  size: number
  /** Undefined while pdf.js is still reading the file. */
  inspection?: PdfFileInspection
  skipFirstPage: boolean
}

type TitleMode = 'paper' | 'filename'

const TUTORIAL_ENTRY_USED_KEY = 'copilotix:tutorial:entry-used:v1'

export default function NewParsePage(props: {
  settings: AppSettings
  /** Passed in, so an edition without them does not bundle them. Absent: just the heading and the import entry, no effects. */
  decoration?: { backdrop: React.ReactNode; wordmark: React.ReactNode; greeting: React.ReactNode }
  /** Papers shown in the progress card: just imported ones and any still being processed. */
  progressDocuments?: readonly DocumentSummary[]
  onCreated(created: DocumentSummary[]): void
  onOpenSettings(): void
  onOpenTutorial?(): void
  onOpenReader?(documentId: string): void
  onShowInLibrary?(documentId: string): void
  onDismissProgress?(documentId: string): void
}): React.JSX.Element {
  const [files, setFiles] = React.useState<PendingPdf[]>([])
  const [tutorialEntryUsed, setTutorialEntryUsed] = React.useState(() => window.localStorage.getItem(TUTORIAL_ENTRY_USED_KEY) === '1')
  const [titleMode, setTitleMode] = React.useState<TitleMode>('paper')
  const [skipDuplicates, setSkipDuplicates] = React.useState(true)
  const [submitting, setSubmitting] = React.useState(false)
  const [dragging, setDragging] = React.useState(false)
  const [zoteroOpen, setZoteroOpen] = React.useState(false)
  const pageRef = React.useRef<HTMLElement>(null)
  const uploadRef = React.useRef<HTMLDivElement>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const dragDepthRef = React.useRef(0)
  const [messageApi, contextHolder] = message.useMessage()

  const setPdfFiles = React.useCallback((nextFiles: File[]): void => {
    setFiles(nextFiles
      .filter((file) => file.name.toLowerCase().endsWith('.pdf'))
      .map((file, index) => ({ key: `${index}:${file.name}:${file.size}:${file.lastModified}`, file, name: file.name, size: file.size, skipFirstPage: false })))
  }, [])
  const chooseFiles = React.useCallback(() => inputRef.current?.click(), [])

  // Page count, metadata title and cover-page check, one file at a time; all local.
  // Inspection restarts only when the selection itself changes, not when an option is toggled.
  const filesRef = React.useRef(files)
  filesRef.current = files
  const selectionKey = files.map((file) => file.key).join('|')
  React.useEffect(() => {
    if (!selectionKey) return
    const controller = new AbortController()
    const pending = filesRef.current.map(({ key, file }) => ({ key, file }))
    void (async () => {
      const { inspectPdfFile } = await import('./pdfInspection')
      for (const { key, file } of pending) {
        if (controller.signal.aborted) return
        const inspection = await inspectPdfFile(file, controller.signal).catch((): PdfFileInspection => ({ status: 'unreadable' }))
        if (controller.signal.aborted) return
        setFiles((current) => current.map((item) => item.key === key
          ? { ...item, inspection, skipFirstPage: inspection.status === 'ready' && inspection.cover !== null && canSkipFirstPage(item, inspection) }
          : item))
      }
    })()
    return () => controller.abort()
  }, [selectionKey])

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

  const { onCreated } = props
  const start = React.useCallback(async () => {
    setSubmitting(true)
    try {
      const fileOptions: ImportFileOptions[] = files.map((file) => ({
        ...(file.skipFirstPage ? { skipFirstPage: true } : {}),
        ...(file.inspection?.status === 'ready' && file.inspection.metadataTitle ? { metadataTitle: file.inspection.metadataTitle } : {})
      }))
      const { created, failed } = await window.copilotix.importDocuments(
        { createDuplicates: !skipDuplicates, useOriginalFilename: titleMode === 'filename' },
        files.map(({ file }) => file),
        fileOptions
      )
      if (failed.length > 0) {
        const examples = failed.slice(0, 3).map((item) => `${item.name}（${item.message}）`).join('；')
        messageApi.warning(`${failed.length} 個 PDF 未匯入：${examples}${failed.length > 3 ? ' 等' : ''}`)
      }
      if (created.length === 0) {
        if (failed.length === 0) messageApi.warning('沒有建立任務；所選 PDF 已存在於論文庫')
        return
      }
      setFiles([])
      onCreated(created)
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : String(error))
    } finally {
      setSubmitting(false)
    }
  }, [files, messageApi, onCreated, skipDuplicates, titleMode])

  const oversizedFiles = files.filter((file) => file.size > MAX_PDF_BYTES)
  const overlongFiles = files.filter((file) => file.inspection?.status === 'ready' && pagesAfterImport(file, file.inspection) > MAX_PDF_PAGES)
  const parserState = props.settings.credentials.parser.state
  const translation = translationPlan(props.settings)
  const { decoration, onOpenTutorial } = props
  const minimal = !decoration
  const titleLabel = minimal ? '顯示標題' : '文庫標題'

  return (
    <section ref={pageRef} className={`page new-parse-page${minimal ? ' is-minimal' : ''}${dragging ? ' is-dragging' : ''}`}>
      {contextHolder}
      {decoration?.backdrop}
      <div className="new-parse-hero">
        {decoration?.wordmark}
        <div className="new-parse-heading">
          {decoration?.greeting}
          <h1>今天想讀些什麼？</h1>
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
          aria-label="文件匯入區，當前支援 PDF"
        >
          <span className="upload-halo" aria-hidden="true" />
          <span className="visually-hidden">可將一個或多個 PDF 檔案拖放到此視窗</span>
          <div className="upload-entry-copy">
            <UploadGlyph />
            <div className="upload-entry-text">
              <span className="upload-prompt">拖入文件</span>
              <small>當前支援 PDF，單篇最多 {MAX_PDF_PAGES} 頁</small>
            </div>
          </div>
          <Button type="primary" size="large" loading={submitting} onClick={chooseFiles}>
            <span>選擇文件</span><ArrowRightOutlined aria-hidden="true" />
          </Button>
          <input
            ref={inputRef}
            className="visually-hidden"
            type="file"
            accept="application/pdf,.pdf"
            multiple
            aria-hidden="true"
            tabIndex={-1}
            onChange={(event) => {
              setPdfFiles([...event.target.files ?? []])
              // The same file can be chosen again after cancelling.
              event.target.value = ''
            }}
          />
        </div>
        <button type="button" className="zotero-entry" onClick={() => setZoteroOpen(true)}>從 Zotero 匯入</button>
        {props.progressDocuments?.length ? (
          <ImportProgress
            documents={props.progressDocuments}
            onOpenReader={(id) => props.onOpenReader?.(id)}
            onShowInLibrary={(id) => props.onShowInLibrary?.(id)}
            onDismiss={(id) => props.onDismissProgress?.(id)}
          />
        ) : null}
        </div>
        {onOpenTutorial && !tutorialEntryUsed ? <button type="button" className="tutorial-entry" onClick={() => {
          window.localStorage.setItem(TUTORIAL_ENTRY_USED_KEY, '1')
          setTutorialEntryUsed(true)
          onOpenTutorial()
        }}>第一次使用？從內建論文開始新手教學 <span aria-hidden="true">→</span></button> : null}
      </div>

      <div className="drop-veil" aria-hidden="true">
        <svg className="drop-veil-frame" preserveAspectRatio="none">
          <rect x="1.5" y="1.5" rx="22" ry="22" />
        </svg>
        <div className="drop-veil-message">
          <UploadGlyph />
          <strong>鬆手，開始匯入</strong>
          <small>僅接收 PDF 檔案</small>
        </div>
      </div>

      <Modal
        title={files.length > 1 ? `確認匯入 ${files.length} 篇 PDF` : '確認匯入'}
        open={files.length > 0}
        width={760}
        okText="開始解析"
        confirmLoading={submitting}
        okButtonProps={{ disabled: parserState === 'missing' || parserState === 'invalid' || oversizedFiles.length > 0 || overlongFiles.length > 0 }}
        footer={(_, { OkBtn }) => <OkBtn />}
        onOk={() => void start()}
        onCancel={() => setFiles([])}
      >
        {parserState === 'missing' ? (
          <Alert
            className="token-required"
            type="warning"
            showIcon
            message="需要先配置解析 API Token"
            description={<Button type="link" onClick={props.onOpenSettings}>前往系統設定</Button>}
          />
        ) : null}
        {parserState === 'invalid' ? (
          <Alert
            className="token-required"
            type="error"
            showIcon
            message="Parser API Token 驗證失敗"
            description={<Button type="link" onClick={props.onOpenSettings}>前往系統設定重新驗證</Button>}
          />
        ) : null}
        <div className="selected-files">
          {files.map((file) => (
            <SelectedPdf key={file.key} file={file} titleMode={titleMode} titleLabel={titleLabel}
              onSkipFirstPage={(skipFirstPage) => setFiles((current) => current.map((item) => item.key === file.key ? { ...item, skipFirstPage } : item))} />
          ))}
        </div>
        {oversizedFiles.length > 0 ? <Alert type="error" showIcon message="解析 API 不接受超過 200MB 的單個檔案" /> : null}
        {overlongFiles.length > 0 ? <Alert type="error" showIcon message={`解析 API 不接受超過 ${MAX_PDF_PAGES} 頁的單個檔案`} /> : null}

        <dl className="import-plan" aria-label="處理方式">
          <div>
            <dt>處理流程</dt>
            <dd>上傳 PDF 到 MinerU 解析 → 生成原文 → 按段翻譯；{minimal ? '完成前即可在左側列表檢視進度' : '完成前即可在首頁和文庫檢視進度'}</dd>
          </div>
          <div>
            <dt>翻譯服務</dt>
            <dd>
              {translation.primary ? <>
                <strong>{translation.primary}</strong>
                {translation.fallbacks.length ? <span className="import-plan-note">失敗的段落依次改用 {translation.fallbacks.join('、')}</span> : null}
              </> : <>
                <span>沒有可用的翻譯服務，解析後只能閱讀原文</span>
                <Button type="link" size="small" onClick={props.onOpenSettings}>前往服務配置</Button>
              </>}
            </dd>
          </div>
          <div>
            <dt>{titleLabel}</dt>
            <dd>
              <Radio.Group className="import-title-mode" value={titleMode} onChange={(event) => setTitleMode(event.target.value as TitleMode)}>
                <Radio value="paper">
                  <span>論文標題</span>
                  <small>先用 PDF 內嵌的標題，解析完成後改為識別出的論文標題</small>
                </Radio>
                <Radio value="filename">
                  <span>原檔名</span>
                  <small>始終顯示檔名，例如“{files[0] ? fileStem(files[0].name) : '論文件名'}”，解析後也不改</small>
                </Radio>
              </Radio.Group>
            </dd>
          </div>
          <div>
            <dt>重複檔案</dt>
            <dd><Checkbox checked={skipDuplicates} onChange={(event) => setSkipDuplicates(event.target.checked)}>{minimal ? '跳過已匯入的相同 PDF' : '跳過文庫中已有的相同 PDF'}</Checkbox></dd>
          </div>
        </dl>
      </Modal>
      <ZoteroImportDialog
        open={zoteroOpen}
        settings={props.settings}
        onClose={() => setZoteroOpen(false)}
        onImported={() => props.onCreated([])}
        onOpenSettings={props.onOpenSettings}
      />
    </section>
  )
}

function SelectedPdf(props: { file: PendingPdf; titleMode: TitleMode; titleLabel: string; onSkipFirstPage(skip: boolean): void }): React.JSX.Element {
  const { file } = props
  const inspection = file.inspection
  const ready = inspection?.status === 'ready' ? inspection : null
  const title = props.titleMode === 'filename'
    ? fileStem(file.name)
    : ready?.metadataTitle ?? (inspection ? '解析後識別，期間顯示檔名' : '正在讀取…')
  return (
    <div className="selected-file" data-file-name={file.name}>
      <FilePdfOutlined aria-hidden="true" />
      <div className="selected-file-main">
        <span className="selected-name">{file.name}</span>
        <span className="selected-file-title"><span>{props.titleLabel}</span>{title}</span>
      </div>
      <small className="selected-file-facts">
        {formatBytes(file.size)}
        {' · '}
        {ready ? `${ready.pageCount} 頁` : !inspection ? <><LoadingOutlined aria-hidden="true" /> 讀取頁數</> : inspectionProblem(inspection)}
      </small>
      {file.size > MAX_PDF_BYTES ? <Tag color="error">超過 200MB</Tag> : ready && pagesAfterImport(file, ready) > MAX_PDF_PAGES ? <Tag color="error">超過 {MAX_PDF_PAGES} 頁</Tag> : null}
      {ready && ready.pageCount >= 2 ? (
        <div className={`selected-file-cover${ready.cover ? ' detected' : ''}`}>
          {ready.cover ? <span>第 1 頁像是{ready.cover.source ? ` ${ready.cover.source} 的` : '機構庫新增的'}版權與引用說明頁，會干擾標題識別和解析，建議跳過。</span> : null}
          {canSkipFirstPage(file, ready)
            ? <Checkbox checked={file.skipFirstPage} onChange={(event) => props.onSkipFirstPage(event.target.checked)}>
                跳過第 1 頁{file.skipFirstPage ? `（匯入 ${ready.pageCount - 1} 頁，原檔案不變）` : ''}
              </Checkbox>
            : <span>檔案超過 {MAX_PDF_CROP_BYTES / 1024 / 1024}MB，無法在本地跳過第 1 頁</span>}
        </div>
      ) : null}
    </div>
  )
}

function canSkipFirstPage(file: Pick<PendingPdf, 'size'>, inspection: PdfFileInspection): boolean {
  return inspection.status === 'ready' && inspection.pageCount >= 2 && file.size <= MAX_PDF_CROP_BYTES
}

function pagesAfterImport(file: PendingPdf, inspection: Extract<PdfFileInspection, { status: 'ready' }>): number {
  return inspection.pageCount - (file.skipFirstPage ? 1 : 0)
}

function inspectionProblem(inspection: PdfFileInspection): string {
  if (inspection.status === 'encrypted') return '已加密，無法預覽'
  if (inspection.status === 'too-large') return '檔案較大，未預覽'
  return '無法讀取頁數'
}

/** The service and model translation starts with, then the ones failed blocks fall back to. */
function translationPlan(settings: AppSettings): { primary: string | null; fallbacks: string[] } {
  const order = executableProviderOrder(settings.translationProviderOrder, settings.enabledTranslationProviders, settings.credentials)
  const describe = (provider: TranslationProviderId): string => {
    const model = provider === 'qwen' ? settings.qwenModel
      : provider === 'deepseek' ? settings.deepseekModel
        : provider === 'codex' ? settings.codex?.translationModel || '預設模型' : ''
    return model ? `${TRANSLATION_PROVIDER_LABELS[provider]}（${model}）` : TRANSLATION_PROVIDER_LABELS[provider]
  }
  return { primary: order[0] ? describe(order[0]) : null, fallbacks: order.slice(1).map(describe) }
}

function fileStem(name: string): string {
  return name.replace(/\.pdf$/iu, '')
}

function formatBytes(value: number): string {
  return value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`
}
