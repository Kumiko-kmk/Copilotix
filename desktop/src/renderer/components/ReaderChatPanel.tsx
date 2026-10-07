import React from 'react'
import { Button, Dropdown, Empty, Input, Progress, Select, message } from 'antd'
import { ArrowUpOutlined, BorderOutlined, CloseOutlined, MoreOutlined } from '@ant-design/icons'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CHAT_CONSENT_VERSION, PAPER_CHAT_MODELS, resolvePaperChatModel, resolvePaperChatProvider, hasPaperChatConsent, type PaperChatProvider } from '@shared/paperChatSchemas'
import type { Citation } from '@shared/ragSchemas'
import type { AppSettings, BlockSelection } from '@shared/types'
import type { PaperChatController, PaperChatTurn } from '../usePaperChat'
import SafeMarkdown from './SafeMarkdown'
import './paperChat.css'

const PROVIDER_LABELS: Record<PaperChatProvider, string> = { qwen: 'Qwen', deepseek: 'DeepSeek' }
const SUGGESTIONS = ['总结这篇论文的主要贡献', '解释论文的核心方法', '实验得出了哪些结论？']

/** Provider, model and readiness derived from the shared translation settings. */
function useChatRouting(chat: PaperChatController) {
  const settingsQuery = useQuery<AppSettings>({ queryKey: ['settings'], queryFn: () => window.copilotix.getSettings() })
  const settings = settingsQuery.data
  const provider = settings ? resolvePaperChatProvider(settings, chat.selectedModel?.provider) : null
  const configured = Boolean(settings && provider && settings.credentials[provider].state === 'valid')
  const defaultModel = provider === 'qwen' ? settings?.qwenChatModel ?? 'qwen-plus' : settings?.deepseekChatModel ?? 'deepseek-flash'
  const selectedModel = chat.selectedModel?.provider === provider ? chat.selectedModel.model : defaultModel
  const model = provider ? resolvePaperChatModel(provider, selectedModel) : ''
  const models = provider ? PAPER_CHAT_MODELS[provider] : []
  const validModel = Boolean(provider && models.includes(model))
  const consented = Boolean(settings && provider && hasPaperChatConsent(settings, provider))
  return { settings, provider, configured, model, models, validModel, consented }
}

async function saveConsent(version: number | null, provider: PaperChatProvider | null = null): Promise<AppSettings> {
  const { credentials: _credentials, ...update } = await window.copilotix.getSettings()
  return (await window.copilotix.saveSettings({ ...update, chatConsentVersion: version, chatConsentProvider: provider })).settings
}

/** Lives in the reader's shared tab toolbar while the chat tab is active. */
export function ReaderChatToolbar(props: { chat: PaperChatController }): React.JSX.Element | null {
  const routing = useChatRouting(props.chat)
  const queryClient = useQueryClient()
  const [messageApi, contextHolder] = message.useMessage()
  const [revoking, setRevoking] = React.useState(false)
  const revoke = async (): Promise<void> => {
    setRevoking(true)
    props.chat.stop()
    try {
      queryClient.setQueryData(['settings'], await saveConsent(null))
      messageApi.success('已撤销发送授权')
    } catch {
      messageApi.error('撤销授权失败，请重试')
    } finally {
      setRevoking(false)
    }
  }
  const menuItems = [
    { key: 'clear', label: '清空对话', disabled: props.chat.loading || props.chat.turns.length === 0 },
    ...(routing.consented ? [{ key: 'revoke', label: '撤销发送授权', disabled: revoking }] : [])
  ]
  return (
    <div className="reader-chat-toolbar">
      {contextHolder}
      <Dropdown
        trigger={['click']}
        menu={{
          items: menuItems,
          onClick: ({ key }) => {
            if (key === 'clear') void props.chat.clear()
            else if (key === 'revoke') void revoke()
          }
        }}
      >
        <Button type="text" size="small" icon={<MoreOutlined />} aria-label="更多问答操作" />
      </Dropdown>
    </div>
  )
}

/** Sits in the composer footer so it fits however narrow the reader pane is. */
function ChatModelPicker(props: { chat: PaperChatController; routing: ReturnType<typeof useChatRouting>; locked: boolean }): React.JSX.Element | null {
  const { chat, routing } = props
  const provider = routing.provider
  return (
    <div className="reader-chat-model-picker">
      <Select
        size="small" variant="borderless" aria-label="问答服务商" className="reader-chat-provider"
        value={provider} disabled={props.locked} popupMatchSelectWidth={false} placement="topLeft" placeholder="服务商"
        options={(Object.keys(PROVIDER_LABELS) as PaperChatProvider[]).map((value) => ({ value, label: PROVIDER_LABELS[value], disabled: !routing.settings?.enabledTranslationProviders.includes(value) }))}
        onChange={(value: PaperChatProvider) => chat.setSelectedModel({ provider: value, model: resolvePaperChatModel(value, value === 'qwen' ? routing.settings?.qwenChatModel : routing.settings?.deepseekChatModel) })}
      />
      <Select
        size="small"
        variant="borderless"
        aria-label="问答模型"
        className="reader-chat-model"
        popupMatchSelectWidth={false}
        placement="topLeft"
        value={routing.model}
        disabled={props.locked || !provider}
        options={routing.models.map((name) => ({ value: name, label: name }))}
        onChange={(model: string) => { if (provider) chat.setSelectedModel({ provider, model }) }}
      />
    </div>
  )
}

export default function ReaderChatPanel(props: {
  documentId: string
  chat: PaperChatController
  active?: boolean
  onSelect(selection: BlockSelection): void
  onOpenSettings(): void
}): React.JSX.Element {
  const { chat } = props
  const routing = useChatRouting(chat)
  const queryClient = useQueryClient()
  const [consentOpen, setConsentOpen] = React.useState(false)
  const [consentSaving, setConsentSaving] = React.useState(false)
  const [localError, setLocalError] = React.useState('')
  const inputRef = React.useRef<HTMLTextAreaElement>(null)
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const indexQuery = useQuery({
    queryKey: ['paper-chat-index', props.documentId],
    queryFn: () => window.copilotix.paperChat.ensureIndex({ documentId: props.documentId }),
    refetchInterval: (query) => ['queued', 'indexing', 'stale'].includes(query.state.data?.state ?? '') ? 1000 : false,
    staleTime: 0
  })
  const ready = indexQuery.data?.state === 'ready'
  const question = chat.draft.trim()
  const canSend = routing.configured && ready && routing.validModel && !consentSaving && !chat.busy && !chat.loading && chat.loaded && question.length > 0

  React.useEffect(() => { setConsentOpen(false) }, [props.documentId])

  // Follow streaming output only while the reader is already at the bottom.
  const lastAnswer = chat.turns.at(-1)?.answer
  React.useLayoutEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return
    if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120) scroller.scrollTop = scroller.scrollHeight
  }, [chat.turns.length, lastAnswer])

  // The question moves into the conversation immediately; a failed turn keeps
  // it and offers retry, so the draft can be cleared up front.
  const submit = React.useCallback(async (): Promise<void> => {
    chat.setDraft('')
    await chat.ask(question, routing.model.trim(), routing.provider ?? undefined)
  }, [chat, question, routing.model, routing.provider])

  const send = (): void => {
    if (!canSend) return
    if (!routing.consented) { setConsentOpen(true); return }
    void submit()
  }

  const agree = async (): Promise<void> => {
    if (!routing.settings || !routing.provider || consentSaving || !routing.validModel) return
    setConsentSaving(true); setLocalError('')
    try {
      const current = await window.copilotix.getSettings()
      if (resolvePaperChatProvider(current, chat.selectedModel?.provider) !== routing.provider) throw new Error('服务商已变更，请重新确认')
      queryClient.setQueryData(['settings'], await saveConsent(CHAT_CONSENT_VERSION, routing.provider))
      setConsentOpen(false)
      await submit()
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : '同意保存失败')
    } finally {
      setConsentSaving(false)
    }
  }

  const cite = React.useCallback(async (citation: Citation): Promise<void> => {
    setLocalError('')
    try {
      const status = await window.copilotix.paperChat.ensureIndex({ documentId: props.documentId })
      if (status.state !== 'ready' || status.contentRevisionId !== citation.locator.contentRevisionId || citation.documentId !== props.documentId) {
        setLocalError('来源已更新，请重新提问')
        return
      }
      const mappingId = citation.locator.mappingIds[0]
      if (!mappingId) { setLocalError('此引用没有可定位的段落'); return }
      props.onSelect({ mappingId, origin: 'citation' })
    } catch {
      setLocalError('无法核对引用来源，请重试')
    }
  }, [props.documentId, props.onSelect])

  const { busy, stop } = chat
  React.useEffect(() => {
    if (!props.active) return
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      const typing = Boolean(target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)))
      if (event.key === '/' && !typing && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault()
        inputRef.current?.focus()
      } else if (event.key === 'Escape' && busy) {
        stop()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [busy, props.active, stop])

  const error = localError || chat.error
  return (
    <section className="paper-chat" aria-label="论文 AI 问答">
      <div className="paper-chat-scroll" ref={scrollRef}>
        {chat.loading ? <p role="status">正在读取本地对话…</p> : null}
        {chat.next ? <Button size="small" loading={chat.loadingOlder} onClick={() => void chat.loadOlder()}>查看更早的对话</Button> : null}
        {chat.loading ? null : chat.turns.length === 0 ? (
          <ChatEmptyState
            provider={routing.provider}
            configured={routing.configured}
            index={indexQuery.data}
            indexFailed={indexQuery.isError}
            onRetryIndex={() => void indexQuery.refetch()}
            onOpenSettings={props.onOpenSettings}
            onSuggest={(text) => { chat.setDraft(text); inputRef.current?.focus() }}
          />
        ) : (
          <div className="paper-chat-turns markdown-body" role="log" aria-label="问答记录">
            {chat.turns.map((turn, index) => (
              <ChatTurn
                key={index}
                turn={turn}
                retryable={!chat.busy && index === chat.turns.length - 1}
                onRetry={() => void chat.ask(turn.question, routing.model.trim(), routing.provider ?? undefined)}
                onCitation={cite}
              />
            ))}
          </div>
        )}
      </div>
      <div className="paper-chat-composer">
        {error ? <div className="paper-chat-error" role="alert">{error}</div> : null}
        {consentOpen ? (
          <div className="paper-chat-consent" role="group" aria-label="同意发送论文片段">
            <strong>同意发送论文片段</strong>
            <p>接收方：{routing.provider === 'qwen' ? '阿里云 Qwen' : 'DeepSeek'}，模型：{routing.model}。API 与当前翻译服务共用。</p>
            <p>会发送当前问题、最近的对话、选中文本与当前论文片段；短论文可能发送完整的已解析文本。可在「⋯」菜单撤销后续发送授权，但不会远程删除服务商已收到的数据。</p>
            <div className="paper-chat-consent-actions">
              <Button size="small" onClick={() => setConsentOpen(false)}>取消</Button>
              <Button size="small" type="primary" loading={consentSaving} onClick={() => void agree()}>同意并发送</Button>
            </div>
          </div>
        ) : null}
        {chat.pinned.length > 0 ? (
          <div className="paper-chat-pins" aria-label="固定选区">
            {chat.pinned.map((pin, index) => {
              const page = pin.fragments[0]?.pageIndex
              return (
                <span className="paper-chat-pin" key={index} title={pin.text}>
                  <span className="paper-chat-pin-source">{pin.view === 'original' ? '原文' : '译文'}{page !== undefined && page !== null ? ` · 第 ${page + 1} 页` : ''}</span>
                  <span className="paper-chat-pin-text">{pin.text.slice(0, 40)}{pin.text.length > 40 ? '…' : ''}</span>
                  <button type="button" aria-label={`移除选区 ${index + 1}`} disabled={chat.busy} onClick={() => chat.removePin(index)}><CloseOutlined /></button>
                </span>
              )
            })}
          </div>
        ) : null}
        <div className="paper-chat-input">
          <Input.TextArea
            ref={(instance) => { inputRef.current = instance?.resizableTextArea?.textArea ?? null }}
            aria-label="向当前论文提问"
            placeholder={routing.configured ? '向当前论文提问（Enter 发送，Shift+Enter 换行）' : '配置翻译服务后即可提问'}
            value={chat.draft}
            variant="borderless"
            maxLength={2000}
            autoSize={{ minRows: 1, maxRows: 6 }}
            onChange={(event) => chat.setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
              event.preventDefault()
              send()
            }}
          />
          <div className="paper-chat-input-footer">
            <ChatModelPicker chat={chat} routing={routing} locked={chat.busy || chat.loading || consentOpen || consentSaving} />
            {chat.busy ? (
              <Button shape="circle" size="small" icon={<BorderOutlined />} aria-label="停止" onClick={chat.stop} />
            ) : (
              <Button shape="circle" size="small" type="primary" icon={<ArrowUpOutlined />} aria-label="发送" disabled={!canSend} onClick={send} />
            )}
          </div>
        </div>
      </div>
    </section>
  )
}

function ChatEmptyState(props: {
  provider: PaperChatProvider | null
  configured: boolean
  index: { state: string; progress?: number } | undefined
  indexFailed: boolean
  onRetryIndex(): void
  onOpenSettings(): void
  onSuggest(text: string): void
}): React.JSX.Element {
  if (!props.configured) {
    return (
      <Empty className="paper-chat-empty" image={Empty.PRESENTED_IMAGE_SIMPLE} description={props.provider
        ? '请先在「服务连接」中验证翻译 API Key，问答直接共用'
        : '当前翻译服务不支持问答，请在设置中选择 Qwen 或 DeepSeek'}>
        <Button onClick={props.onOpenSettings}>前往设置</Button>
      </Empty>
    )
  }
  if (props.index?.state !== 'ready') {
    const description = props.indexFailed ? '索引准备失败' : props.index?.state === 'unindexed' ? '请先完成论文解析' : '论文索引准备中'
    return (
      <Empty className="paper-chat-empty" image={Empty.PRESENTED_IMAGE_SIMPLE} description={description}>
        {props.indexFailed || props.index?.state === 'failed'
          ? <Button onClick={props.onRetryIndex}>重试索引</Button>
          : <Progress className="paper-chat-index-progress" percent={props.index?.progress ?? 0} size="small" />}
      </Empty>
    )
  }
  return (
    <div className="paper-chat-empty paper-chat-welcome">
      <p>只依据当前论文回答，回答中的引用可以点击定位到原文。对话随论文保存在本地，下次打开时继续保留。</p>
      <div className="paper-chat-suggestions">
        {SUGGESTIONS.map((text) => <button type="button" key={text} onClick={() => props.onSuggest(text)}>{text}</button>)}
      </div>
    </div>
  )
}

function ChatTurn(props: {
  turn: PaperChatTurn
  retryable: boolean
  onRetry(): void
  onCitation(citation: Citation): void
}): React.JSX.Element {
  const { turn } = props
  const citations = turn.status === 'completed' ? turn.citations : undefined
  const labels = React.useMemo(() => citationLabels(turn.answer, citations), [citations, turn.answer])
  return (
    <article className="paper-chat-turn">
      <h4 className="paper-chat-question">{turn.question}</h4>
      <div className="paper-chat-answer">
        <SafeMarkdown markdown={turn.answer} citations={citations ?? {}} citationLabels={labels} onCitation={props.onCitation} />
        {turn.status === 'pending' ? <span className="paper-chat-caret" aria-label="正在生成" /> : null}
      </div>
      {turn.status === 'cancelled' || turn.status === 'failed' ? (
        <div className="paper-chat-status">
          <span>{turn.status === 'cancelled' ? '已停止' : '回答失败'}</span>
          {props.retryable ? <Button type="link" size="small" onClick={props.onRetry}>重试</Button> : null}
        </div>
      ) : null}
    </article>
  )
}

/** Number verified evidence markers 1…n in the order they first appear. */
function citationLabels(answer: string, citations: Record<string, Citation> | undefined): Record<string, number> {
  const labels: Record<string, number> = {}
  if (!citations) return labels
  for (const match of answer.matchAll(/\[(E\d+)\]/gu)) {
    const id = match[1]!
    if (citations[id] && labels[id] === undefined) labels[id] = Object.keys(labels).length + 1
  }
  return labels
}
