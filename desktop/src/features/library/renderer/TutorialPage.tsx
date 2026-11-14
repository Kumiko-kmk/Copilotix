import React from 'react'
import { ArrowRightOutlined, CheckOutlined, CloudUploadOutlined, FilePdfOutlined, LinkOutlined, ReadOutlined } from '@ant-design/icons'
import { Button, Input, Modal, Tag, message } from 'antd'
import type { DocumentSummary } from '../contract/documentSchemas'
import type { AppSettings, SettingsUpdate } from '@features/settings/contract/settingsTypes'
import {
  MINERU_API_TOKEN_URL,
  TUTORIAL_PAPER_PAGES,
  TUTORIAL_PAPER_SHA256,
  TUTORIAL_PAPER_SOURCE_URL,
  TUTORIAL_PAPER_TITLE
} from '../contract/tutorialSample'

const taskStatus: Record<DocumentSummary['workflow']['status'], string> = {
  queued: '排隊中', uploading: '上傳中', parsing: '解析中', translating: '翻譯中',
  partial: '部分完成', completed: '已完成', failed: '失敗'
}

const TUTORIAL_API_VERIFIED_KEY = 'copilotix:tutorial:api-verified:v1'

function stageProgress(sample: DocumentSummary | null): { parse: number; translation: number } {
  if (!sample) return { parse: 0, translation: 0 }
  const { status, progress } = sample.workflow
  return {
    parse: ['translating', 'partial', 'completed'].includes(status) ? 100 : ['uploading', 'parsing'].includes(status) ? progress : 0,
    translation: status === 'completed' ? 100 : ['translating', 'partial'].includes(status) ? progress : 0
  }
}

function ProgressRow(props: { label: string; progress: number; status: string }): React.JSX.Element {
  return <div className="tutorial-progress-row">
    <div className="tutorial-progress-label"><strong>{props.label}</strong><span>{props.status} · {props.progress}%</span></div>
    <div className="tutorial-progress-track" role="progressbar" aria-label={`${props.label}進度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={props.progress}>
      <span style={{ width: `${props.progress}%` }} />
    </div>
  </div>
}

export default function TutorialPage(props: {
  settings: AppSettings
  documents: DocumentSummary[]
  onSettingsSaved(settings: AppSettings): void
  onOpenReader(documentId: string): void
  onImported(document: DocumentSummary): void
  onClose(): void
}): React.JSX.Element {
  const [importing, setImporting] = React.useState(false)
  const [lastImported, setLastImported] = React.useState<DocumentSummary | null>(null)
  const [apiOpen, setApiOpen] = React.useState(false)
  const [apiToken, setApiToken] = React.useState('')
  const [apiSaving, setApiSaving] = React.useState(false)
  const [apiError, setApiError] = React.useState('')
  const [readerOpened, setReaderOpened] = React.useState(false)
  const [replaying, setReplaying] = React.useState(() => window.localStorage.getItem('copilotix:tutorial:replay') === '1')
  const [activeId, setActiveId] = React.useState(() => window.localStorage.getItem('copilotix:tutorial:active-id'))
  const [messageApi, contextHolder] = message.useMessage()
  const sample = replaying ? lastImported : activeId
    ? props.documents.find((document) => document.id === activeId) ?? lastImported
    : props.documents.find((document) => document.sourceHash === TUTORIAL_PAPER_SHA256) ?? lastImported
  const parserReady = props.settings.credentials.parser.state === 'valid'
  const apiStepComplete = parserReady
  const taskComplete = sample?.workflow.status === 'completed'
  const canRead = sample && ['translating', 'partial', 'completed'].includes(sample.workflow.status)
  const progress = stageProgress(sample ?? null)

  React.useEffect(() => {
    setReaderOpened(Boolean(sample && window.localStorage.getItem(`copilotix:tutorial:read:${sample.id}`)))
  }, [sample?.id])

  const saveApi = React.useCallback(async () => {
    const value = apiToken.trim()
    if (!value) { setApiError('請先輸入從 MinerU API 管理頁面生成的 Token'); return }
    setApiSaving(true)
    setApiError('')
    try {
      const validation = await window.copilotix.validateCredential('parser', value)
      if (validation.state !== 'valid') {
        setApiError(validation.message ?? 'MinerU API 驗證失敗，請檢查 Token')
        return
      }
      const { credentials: _credentials, keyStatuses: _keyStatuses, ...publicSettings } = props.settings
      const update: SettingsUpdate = { ...publicSettings, credentialMutations: { parser: { action: 'set', value } } }
      const saved = await window.copilotix.saveSettings(update)
      const fieldError = saved.fieldErrors.parser
      if (fieldError || saved.settings.credentials.parser.state !== 'valid') {
        setApiError(fieldError?.message ?? 'MinerU API 未能儲存，請重試')
        return
      }
      props.onSettingsSaved(saved.settings)
      window.localStorage.setItem(TUTORIAL_API_VERIFIED_KEY, '1')
      setApiToken('')
      setApiOpen(false)
      messageApi.success('MinerU API 已自動驗證並儲存')
    } catch (error) {
      setApiError(error instanceof Error ? error.message : String(error))
    } finally {
      setApiSaving(false)
    }
  }, [apiToken, messageApi, props.onSettingsSaved, props.settings])

  const importPaper = React.useCallback(async () => {
    setImporting(true)
    try {
      const document = await window.copilotix.importTutorialPaper(replaying)
      if (!document) return
      window.localStorage.setItem('copilotix:tutorial:active-id', document.id)
      window.localStorage.removeItem('copilotix:tutorial:replay')
      window.localStorage.removeItem('copilotix:tutorial:replay-api-confirmed')
      setActiveId(document.id)
      setReplaying(false)
      setLastImported(document)
      props.onImported(document)
      messageApi.success('示例論文已加入任務佇列，解析將自動開始')
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : String(error))
    } finally {
      setImporting(false)
    }
  }, [messageApi, props.onImported, replaying])

  const restartTutorial = (): void => {
    window.localStorage.setItem('copilotix:tutorial:replay', '1')
    window.localStorage.removeItem(TUTORIAL_API_VERIFIED_KEY)
    window.localStorage.removeItem('copilotix:tutorial:active-id')
    window.localStorage.removeItem('copilotix:tutorial:replay-api-confirmed')
    for (const key of Object.keys(window.localStorage)) {
      if (key.startsWith('copilotix:tutorial:read:')) window.localStorage.removeItem(key)
    }
    setLastImported(null)
    setActiveId(null)
    setReaderOpened(false)
    setReplaying(true)
  }

  const openReader = (): void => {
    if (!sample) return
    window.localStorage.setItem(`copilotix:tutorial:read:${sample.id}`, '1')
    setReaderOpened(true)
    props.onOpenReader(sample.id)
  }

  return (
    <section className="page tutorial-page" aria-label="新手教學">
      {contextHolder}
      <header className="page-header page-brand tutorial-page-header">
        <div className="page-brand-copy"><span className="eyebrow tutorial-eyebrow">COPILOTIX / TUTORIAL · 入門體驗</span><h1>用一篇經典論文，走完第一次解析</h1></div>
        <div className="tutorial-header-actions">
          <Button onClick={restartTutorial}>重新體驗教學</Button>
          <Button onClick={props.onClose}>返回新解析</Button>
        </div>
      </header>

      <div className="tutorial-intro">
        <div className="tutorial-intro-copy">
          <h2>{TUTORIAL_PAPER_TITLE}!</h2>
          <p>Vaswani 等人於 2017 年提出的經典論文，以注意力機制構建 Transformer，展示了無需迴圈網路也能完成高質量機器翻譯的路徑。跟著這篇 {TUTORIAL_PAPER_PAGES} 頁的論文，親手完成 API 配置、解析、翻譯與閱讀。</p>
          <a href={TUTORIAL_PAPER_SOURCE_URL} target="_blank" rel="noreferrer">檢視論文來源 · arXiv:1706.03762 <ArrowRightOutlined /></a>
        </div>
        <div className="tutorial-paper-art" aria-hidden="true"><FilePdfOutlined /><span>Attention<br />Is All You Need</span><small>Vaswani et al. · 2017</small></div>
      </div>

      <div className="tutorial-steps" role="list" aria-label="入門步驟">
        <article className={`tutorial-step${apiStepComplete ? ' is-complete' : ''}`} role="listitem">
          {apiStepComplete ? <span className="tutorial-step-completion" aria-label="第 1 步已完成"><CheckOutlined /></span> : null}
          <div className="tutorial-step-top"><span className="tutorial-step-number">步驟 01 / 04</span><Tag color={apiStepComplete ? 'success' : 'processing'}>{apiStepComplete ? '已完成' : '待配置'}</Tag></div>
          <div className="tutorial-step-title"><LinkOutlined /><h3>註冊並生成 MinerU API</h3></div>
          <p>先在 MinerU 註冊並進入 API 管理頁申領 Token。複製申領到的 API，貼上到下方視窗；教學會自動驗證並儲存。</p>
          <div className="tutorial-step-actions">
            <a className="tutorial-api-link" href={MINERU_API_TOKEN_URL} target="_blank" rel="noreferrer">前往 MinerU API 申領頁 <ArrowRightOutlined /></a>
            <Button onClick={() => { setApiError(''); setApiOpen(true) }}>輸入申領到的 API</Button>
          </div>
        </article>

        <article className={`tutorial-step${sample ? ' is-complete' : ''}`} role="listitem">
          {sample ? <span className="tutorial-step-completion" aria-label="第 2 步已完成"><CheckOutlined /></span> : null}
          <div className="tutorial-step-top"><span className="tutorial-step-number">步驟 02 / 04</span><Tag color={sample ? 'success' : 'default'}>{sample ? '已完成' : '等待選擇'}</Tag></div>
          <div className="tutorial-step-title"><CloudUploadOutlined /><h3>選擇內建論文</h3></div>
          <p>點選“選擇文件”，系統視窗會預選以內建論文標題命名的 PDF。確認開啟後，論文才會加入文庫並開始解析。</p>
          <div className="tutorial-step-actions">
            <Button type="primary" loading={importing} disabled={!apiStepComplete || Boolean(sample)} onClick={() => void importPaper()}>{sample ? '論文已加入任務' : '選擇文件'}</Button>
            {!apiStepComplete ? <small>請先輸入並驗證 MinerU API</small> : null}
          </div>
        </article>

        <article className={`tutorial-step${taskComplete ? ' is-complete' : ''}`} role="listitem">
          {taskComplete ? <span className="tutorial-step-completion" aria-label="第 3 步已完成"><CheckOutlined /></span> : null}
          <div className="tutorial-step-top"><span className="tutorial-step-number">步驟 03 / 04</span><Tag color={taskComplete ? 'success' : sample ? 'processing' : 'default'}>{taskComplete ? '已完成' : sample ? taskStatus[sample.workflow.status] : '等待任務'}</Tag></div>
          <div className="tutorial-step-title"><CheckOutlined /><h3>跟蹤解析與翻譯</h3></div>
          <p>任務開始後，解析與翻譯會依次進行。下方分別顯示兩個階段的進度；若尚未配置翻譯服務，可稍後在設定中完成。</p>
          <div className="tutorial-progress-list">
            <ProgressRow label="解析" progress={progress.parse} status={!sample ? '等待上傳' : progress.parse === 100 ? '已完成' : taskStatus[sample.workflow.status]} />
            <ProgressRow label="翻譯" progress={progress.translation} status={!sample || progress.parse < 100 ? '等待解析' : progress.translation === 100 && taskComplete ? '已完成' : taskStatus[sample.workflow.status]} />
          </div>
        </article>

        <article className={`tutorial-step${readerOpened ? ' is-complete' : ''}`} role="listitem">
          {readerOpened ? <span className="tutorial-step-completion" aria-label="第 4 步已完成"><CheckOutlined /></span> : null}
          <div className="tutorial-step-top"><span className="tutorial-step-number">步驟 04 / 04</span><Tag color={readerOpened ? 'success' : 'default'}>{readerOpened ? '已完成' : '等待閱讀'}</Tag></div>
          <div className="tutorial-step-title"><ReadOutlined /><h3>跳轉論文閱讀器</h3></div>
          <p>解析完成後，跳轉到論文閱讀器檢視原文、結構化內容與譯文。切換閱讀檢視，還能使用縮略導覽快速定位章節。</p>
          <div className="tutorial-step-actions"><Button disabled={!canRead} onClick={openReader}>跳轉論文閱讀器</Button></div>
        </article>
      </div>

      <Modal className="tutorial-token-modal" title="連線 MinerU API" open={apiOpen} footer={null} onCancel={() => { if (!apiSaving) { setApiOpen(false); setApiToken('') } }} closable={!apiSaving} maskClosable={!apiSaving}>
        <p>在 MinerU API 申領頁取得 Token 後貼上到這裡。驗證成功會自動儲存到系統憑據儲存。</p>
        <label htmlFor="tutorial-mineru-token">MinerU Token</label>
        <Input.Password id="tutorial-mineru-token" value={apiToken} onChange={(event) => { setApiToken(event.target.value); setApiError('') }} onPressEnter={() => void saveApi()} placeholder="貼上 MinerU Token" autoComplete="off" />
        {apiError ? <p className="tutorial-token-error" role="alert">{apiError}</p> : null}
        <div className="tutorial-token-actions"><Button onClick={() => { setApiOpen(false); setApiToken('') }} disabled={apiSaving}>取消</Button><Button type="primary" loading={apiSaving} onClick={() => void saveApi()}>驗證並儲存</Button></div>
      </Modal>
    </section>
  )
}
