import React from 'react'
import { ArrowRightOutlined, CheckOutlined, CloudUploadOutlined, FilePdfOutlined, LinkOutlined, ReadOutlined } from '@ant-design/icons'
import { Button, Input, Modal, Tag, message } from 'antd'
import type { DocumentSummary } from '@shared/ipcSchemas'
import type { AppSettings, SettingsUpdate } from '@shared/types'
import {
  MINERU_API_TOKEN_URL,
  TUTORIAL_PAPER_PAGES,
  TUTORIAL_PAPER_SHA256,
  TUTORIAL_PAPER_SOURCE_URL,
  TUTORIAL_PAPER_TITLE
} from '@shared/tutorialSample'

const taskStatus: Record<DocumentSummary['workflow']['status'], string> = {
  queued: '排队中', uploading: '上传中', parsing: '解析中', translating: '翻译中',
  partial: '部分完成', completed: '已完成', failed: '失败'
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
    <div className="tutorial-progress-track" role="progressbar" aria-label={`${props.label}进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={props.progress}>
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
  const [apiVerified, setApiVerified] = React.useState(() => window.localStorage.getItem(TUTORIAL_API_VERIFIED_KEY) === '1')
  const [activeId, setActiveId] = React.useState(() => window.localStorage.getItem('copilotix:tutorial:active-id'))
  const [messageApi, contextHolder] = message.useMessage()
  const sample = replaying ? lastImported : activeId
    ? props.documents.find((document) => document.id === activeId) ?? lastImported
    : props.documents.find((document) => document.sourceHash === TUTORIAL_PAPER_SHA256) ?? lastImported
  const parserReady = props.settings.credentials.parser.state === 'valid'
  const apiStepComplete = parserReady && apiVerified
  const taskComplete = sample?.workflow.status === 'completed'
  const canRead = sample && ['translating', 'partial', 'completed'].includes(sample.workflow.status)
  const progress = stageProgress(sample ?? null)

  React.useEffect(() => {
    setReaderOpened(Boolean(sample && window.localStorage.getItem(`copilotix:tutorial:read:${sample.id}`)))
  }, [sample?.id])

  const saveApi = React.useCallback(async () => {
    const value = apiToken.trim()
    if (!value) { setApiError('请先输入从 MinerU API 管理页面生成的 Token'); return }
    setApiSaving(true)
    setApiError('')
    try {
      const validation = await window.copilotix.validateCredential('parser', value)
      if (validation.state !== 'valid') {
        setApiError(validation.message ?? 'MinerU API 验证失败，请检查 Token')
        return
      }
      const { credentials: _credentials, ...publicSettings } = props.settings
      const update: SettingsUpdate = { ...publicSettings, credentialMutations: { parser: { action: 'set', value } } }
      const saved = await window.copilotix.saveSettings(update)
      const fieldError = saved.fieldErrors.parser
      if (fieldError || saved.settings.credentials.parser.state !== 'valid') {
        setApiError(fieldError?.message ?? 'MinerU API 未能保存，请重试')
        return
      }
      props.onSettingsSaved(saved.settings)
      window.localStorage.setItem(TUTORIAL_API_VERIFIED_KEY, '1')
      setApiVerified(true)
      setApiToken('')
      setApiOpen(false)
      messageApi.success('MinerU API 已自动验证并保存')
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
      messageApi.success('示例论文已加入任务队列，解析将自动开始')
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
    setApiVerified(false)
    setReplaying(true)
  }

  const openReader = (): void => {
    if (!sample) return
    window.localStorage.setItem(`copilotix:tutorial:read:${sample.id}`, '1')
    setReaderOpened(true)
    props.onOpenReader(sample.id)
  }

  return (
    <section className="page tutorial-page" aria-label="新手教程">
      {contextHolder}
      <header className="page-header tutorial-page-header">
        <div><span className="tutorial-eyebrow">COPILOTIX · 入门体验</span><h1>用一篇经典论文，走完第一次解析</h1></div>
        <div className="tutorial-header-actions">
          <Button onClick={restartTutorial}>重新体验教程</Button>
          <Button onClick={props.onClose}>返回新解析</Button>
        </div>
      </header>

      <div className="tutorial-intro">
        <div className="tutorial-intro-copy">
          <h2>{TUTORIAL_PAPER_TITLE}!</h2>
          <p>Vaswani 等人于 2017 年提出的经典论文，以注意力机制构建 Transformer，展示了无需循环网络也能完成高质量机器翻译的路径。跟着这篇 {TUTORIAL_PAPER_PAGES} 页的论文，亲手完成 API 配置、解析、翻译与阅读。</p>
          <a href={TUTORIAL_PAPER_SOURCE_URL} target="_blank" rel="noreferrer">查看论文来源 · arXiv:1706.03762 <ArrowRightOutlined /></a>
        </div>
        <div className="tutorial-paper-art" aria-hidden="true"><FilePdfOutlined /><span>Attention<br />Is All You Need</span><small>Vaswani et al. · 2017</small></div>
      </div>

      <div className="tutorial-steps" role="list" aria-label="入门步骤">
        <article className={`tutorial-step${apiStepComplete ? ' is-complete' : ''}`} role="listitem">
          {apiStepComplete ? <span className="tutorial-step-completion" aria-label="第 1 步已完成"><CheckOutlined /></span> : null}
          <div className="tutorial-step-top"><span className="tutorial-step-number">步骤 01 / 04</span><Tag color={apiStepComplete ? 'success' : 'processing'}>{apiStepComplete ? '已完成' : '待配置'}</Tag></div>
          <div className="tutorial-step-title"><LinkOutlined /><h3>注册并生成 MinerU API</h3></div>
          <p>先在 MinerU 注册并进入 API 管理页申领 Token。复制申领到的 API，粘贴到下方窗口；教程会自动验证并保存。</p>
          <div className="tutorial-step-actions">
            <a className="tutorial-api-link" href={MINERU_API_TOKEN_URL} target="_blank" rel="noreferrer">前往 MinerU API 申领页 <ArrowRightOutlined /></a>
            <Button onClick={() => { setApiError(''); setApiOpen(true) }}>输入申领到的 API</Button>
          </div>
        </article>

        <article className={`tutorial-step${sample ? ' is-complete' : ''}`} role="listitem">
          {sample ? <span className="tutorial-step-completion" aria-label="第 2 步已完成"><CheckOutlined /></span> : null}
          <div className="tutorial-step-top"><span className="tutorial-step-number">步骤 02 / 04</span><Tag color={sample ? 'success' : 'default'}>{sample ? '已完成' : '等待选择'}</Tag></div>
          <div className="tutorial-step-title"><CloudUploadOutlined /><h3>选择内置论文</h3></div>
          <p>点击“选择文档”，系统窗口会预选以内置论文标题命名的 PDF。确认打开后，论文才会加入文库并开始解析。</p>
          <div className="tutorial-step-actions">
            <Button type="primary" loading={importing} disabled={!apiStepComplete || Boolean(sample)} onClick={() => void importPaper()}>{sample ? '论文已加入任务' : '选择文档'}</Button>
            {!apiStepComplete ? <small>请先输入并验证 MinerU API</small> : null}
          </div>
        </article>

        <article className={`tutorial-step${taskComplete ? ' is-complete' : ''}`} role="listitem">
          {taskComplete ? <span className="tutorial-step-completion" aria-label="第 3 步已完成"><CheckOutlined /></span> : null}
          <div className="tutorial-step-top"><span className="tutorial-step-number">步骤 03 / 04</span><Tag color={taskComplete ? 'success' : sample ? 'processing' : 'default'}>{taskComplete ? '已完成' : sample ? taskStatus[sample.workflow.status] : '等待任务'}</Tag></div>
          <div className="tutorial-step-title"><CheckOutlined /><h3>跟踪解析与翻译</h3></div>
          <p>任务开始后，解析与翻译会依次进行。下方分别显示两个阶段的进度；若尚未配置翻译服务，可稍后在设置中完成。</p>
          <div className="tutorial-progress-list">
            <ProgressRow label="解析" progress={progress.parse} status={!sample ? '等待上传' : progress.parse === 100 ? '已完成' : taskStatus[sample.workflow.status]} />
            <ProgressRow label="翻译" progress={progress.translation} status={!sample || progress.parse < 100 ? '等待解析' : progress.translation === 100 && taskComplete ? '已完成' : taskStatus[sample.workflow.status]} />
          </div>
        </article>

        <article className={`tutorial-step${readerOpened ? ' is-complete' : ''}`} role="listitem">
          {readerOpened ? <span className="tutorial-step-completion" aria-label="第 4 步已完成"><CheckOutlined /></span> : null}
          <div className="tutorial-step-top"><span className="tutorial-step-number">步骤 04 / 04</span><Tag color={readerOpened ? 'success' : 'default'}>{readerOpened ? '已完成' : '等待阅读'}</Tag></div>
          <div className="tutorial-step-title"><ReadOutlined /><h3>跳转论文阅读器</h3></div>
          <p>解析完成后，跳转到论文阅读器查看原文、结构化内容与译文。切换阅读视图，还能使用缩略导航快速定位章节。</p>
          <div className="tutorial-step-actions"><Button disabled={!canRead} onClick={openReader}>跳转论文阅读器</Button></div>
        </article>
      </div>

      <Modal className="tutorial-token-modal" title="连接 MinerU API" open={apiOpen} footer={null} onCancel={() => { if (!apiSaving) { setApiOpen(false); setApiToken('') } }} closable={!apiSaving} maskClosable={!apiSaving}>
        <p>在 MinerU API 申领页取得 Token 后粘贴到这里。验证成功会自动保存到系统凭据存储。</p>
        <label htmlFor="tutorial-mineru-token">MinerU Token</label>
        <Input.Password id="tutorial-mineru-token" value={apiToken} onChange={(event) => { setApiToken(event.target.value); setApiError('') }} onPressEnter={() => void saveApi()} placeholder="粘贴 MinerU Token" autoComplete="off" />
        {apiError ? <p className="tutorial-token-error" role="alert">{apiError}</p> : null}
        <div className="tutorial-token-actions"><Button onClick={() => { setApiOpen(false); setApiToken('') }} disabled={apiSaving}>取消</Button><Button type="primary" loading={apiSaving} onClick={() => void saveApi()}>验证并保存</Button></div>
      </Modal>
    </section>
  )
}
