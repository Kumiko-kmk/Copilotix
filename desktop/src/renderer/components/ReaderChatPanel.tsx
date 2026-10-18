import React from 'react'
import { DEFAULT_CODEX_SETTINGS } from '@shared/codex'
import { Button, Dropdown, Empty, Input, Modal, Progress, Select } from 'antd'
import { ArrowUpOutlined, BorderOutlined, CloseOutlined, MoreOutlined } from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import { PAPER_CHAT_MODELS, resolvePaperChatModel, resolvePaperChatProvider, type PaperChatProvider } from '@shared/paperChatSchemas'
import type { Citation } from '@shared/ragSchemas'
import type { AppSettings, BlockSelection } from '@shared/types'
import type { PaperChatController, PaperChatTurn } from '../usePaperChat'
import SafeMarkdown from './SafeMarkdown'
import './paperChat.css'

const PROVIDER_LABELS: Record<PaperChatProvider, string> = { qwen: 'Qwen', deepseek: 'DeepSeek', codex: 'Codex' }
const SUGGESTIONS = ['总结这篇论文的主要贡献', '解释论文的核心方法', '实验得出了哪些结论？']

/** Provider, model and readiness derived from the shared translation settings. */
function useChatRouting(chat: PaperChatController) {
  const settingsQuery = useQuery<AppSettings>({ queryKey: ['settings'], queryFn: () => window.copilotix.getSettings() })
  const settings = settingsQuery.data
  const provider = settings ? resolvePaperChatProvider(settings, chat.selectedModel?.provider) : null
  const codexQuery = useQuery({ queryKey: ['codex', settings?.codex], queryFn: () => window.copilotix.codex.inspect({ settings: settings?.codex ?? DEFAULT_CODEX_SETTINGS }), enabled: provider === 'codex', staleTime: 60_000, retry: false })
  const configured = Boolean(settings && provider && (provider === 'codex' ? codexQuery.data?.state === 'ready' : settings.credentials[provider].state === 'valid'))
  const defaultModel = provider === 'codex' ? settings?.codex?.chatModel ?? 'default' : provider === 'qwen' ? settings?.qwenChatModel ?? 'qwen-plus' : settings?.deepseekChatModel ?? 'deepseek-flash'
  const selectedModel = chat.selectedModel?.provider === provider ? chat.selectedModel.model : defaultModel
  const model = provider ? resolvePaperChatModel(provider, selectedModel) : ''
  const models = provider === 'codex' ? codexQuery.data?.models.map(model => model.id) ?? [] : provider ? PAPER_CHAT_MODELS[provider] : []
  const validModel = Boolean(provider && models.includes(model))
  return { settings, provider, configured, model, models, validModel }
}

/** Lives in the reader's shared tab toolbar while the chat tab is active. */
export function ReaderChatToolbar(props: { chat: PaperChatController; children?: React.ReactNode }): React.JSX.Element | null {
  const menuItems = [{ key: 'clear', label: '清空对话', disabled: props.chat.loading || props.chat.turns.length === 0 }]
  return (
    <div className="reader-chat-toolbar">
      {props.children}
      <Dropdown
        trigger={['click']}
        menu={{
          items: menuItems,
          onClick: ({ key }) => {
            if (key === 'clear') void props.chat.clear()
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
        title=""
        size="small" variant="borderless" aria-label="问答服务商" className="reader-chat-provider"
        value={provider} disabled={props.locked} popupMatchSelectWidth={false} placement="topLeft" placeholder="服务商"
        options={(Object.keys(PROVIDER_LABELS) as PaperChatProvider[]).map((value) => ({ value, label: PROVIDER_LABELS[value], title: '', disabled: !routing.settings?.enabledTranslationProviders.includes(value) }))}
        onChange={(value: PaperChatProvider) => chat.setSelectedModel({ provider: value, model: resolvePaperChatModel(value, value === 'codex' ? routing.settings?.codex?.chatModel : value === 'qwen' ? routing.settings?.qwenChatModel : routing.settings?.deepseekChatModel) })}
      />
      <Select
        title=""
        size="small"
        variant="borderless"
        aria-label="问答模型"
        className="reader-chat-model"
        popupMatchSelectWidth={false}
        placement="topLeft"
        value={routing.model}
        disabled={props.locked || !provider}
        options={routing.models.map((name) => ({ value: name, label: name, title: '' }))}
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
  const canSend = routing.configured && ready && routing.validModel && !chat.busy && !chat.loading && chat.loaded && question.length > 0


  // Follow streaming output only while the reader is already at the bottom.
  const lastAnswer = chat.turns.at(-1)?.answer
  React.useLayoutEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return
    if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120) scroller.scrollTop = scroller.scrollHeight
  }, [chat.turns.length, lastAnswer])

  // The question and its selections move into the conversation immediately; a
  // failed turn keeps them and offers retry, so the composer can be cleared up front.
  const submit = React.useCallback(async (): Promise<void> => {
    chat.setDraft('')
    await chat.ask(question, routing.model.trim(), routing.provider ?? undefined)
  }, [chat, question, routing.model, routing.provider])

  const send = (): void => {
    if (!canSend) return
    void submit()
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
    <section className="paper-chat" aria-label="论文 Chat">
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
                key={turn.id ?? `${turn.createdAt ?? index}:${turn.question}`}
                turn={turn}
                deleteDisabled={chat.busy || chat.loadingOlder}
                onDelete={() => chat.deleteTurn(turn)}
                retryable={!chat.busy && index === chat.turns.length - 1}
                onRetry={() => void chat.ask(turn.question, routing.model.trim(), routing.provider ?? undefined, turn.pinned ?? [])}
                onCitation={cite}
              />
            ))}
          </div>
        )}
      </div>
      <div className="paper-chat-composer">
        {error ? <div className="paper-chat-error" role="alert">{error}</div> : null}
        {chat.pinned.length > 0 ? (
          <div className="paper-chat-pins" aria-label="固定选区">
            {chat.pinned.map((pin, index) => {
              return (
                <span className="paper-chat-pin" key={index}>
                  <SelectionLabel view={pin.view} text={pin.text} pageIndex={pin.fragments[0]?.pageIndex} />
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
            <ChatModelPicker chat={chat} routing={routing} locked={chat.busy || chat.loading} />
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
  deleteDisabled: boolean
  onDelete(): Promise<void>
  retryable: boolean
  onRetry(): void
  onCitation(citation: Citation): void
}): React.JSX.Element {
  const { turn } = props
  const [collapsed, setCollapsed] = React.useState(false)
  const [confirming, setConfirming] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)
  const [deleteError, setDeleteError] = React.useState('')
  const remove = async (): Promise<void> => {
    setDeleting(true); setDeleteError('')
    try { await props.onDelete(); setConfirming(false) }
    catch (error) { setDeleteError(error instanceof Error ? error.message : '删除失败，请重试') }
    finally { setDeleting(false) }
  }
  const citations = turn.status === 'completed' ? turn.citations : undefined
  const labels = React.useMemo(() => citationLabels(turn.answer, citations), [citations, turn.answer])
  return (
    <article className="paper-chat-turn">
      {turn.selections?.length ? (
        <div className="paper-chat-turn-selections" aria-label="提问附带的选区">
          {turn.selections.map((selection, index) => (
            <span className="paper-chat-pin" key={index}><SelectionLabel {...selection} /></span>
          ))}
        </div>
      ) : null}
      <div className="paper-chat-question-row">
        <h4 className="paper-chat-question">{turn.question}</h4>
        <Dropdown trigger={['click']} menu={{ items: [
          { key: 'collapse', label: collapsed ? '展开回复' : '折叠回复' },
          { key: 'delete', label: '删除聊天', danger: true, disabled: props.deleteDisabled || deleting }
        ], onClick: ({ key }) => { if (key === 'collapse') setCollapsed(value => !value); else setConfirming(true) } }}>
          <Button type="text" size="small" icon={<MoreOutlined />} aria-label="此条聊天操作" />
        </Dropdown>
      </div>
      <div hidden={collapsed}>

      <div className="paper-chat-answer">
        <SafeMarkdown markdown={turn.answer} citations={citations ?? {}} citationLabels={labels} onCitation={props.onCitation} />
        {turn.status === 'pending' ? <span className="paper-chat-caret" aria-label="正在生成" /> : null}
      </div>
      {turn.status !== 'pending' ? (
        <div className="paper-chat-metadata" aria-label="回答信息">
          <span>{turn.model ?? '模型未记录'}</span>
          {turn.completedAt || turn.createdAt ? <time dateTime={turn.completedAt ?? turn.createdAt}>{new Date(turn.completedAt ?? turn.createdAt!).toLocaleString('zh-CN', { hour12: false })}</time> : <span>时间未记录</span>}
          <span>{turn.usage ? `${turn.usage.totalTokens.toLocaleString()} Tokens（输入 ${turn.usage.promptTokens.toLocaleString()} / 输出 ${turn.usage.completionTokens.toLocaleString()}）` : 'Token 用量未提供'}</span>
        </div>
      ) : null}
      {turn.status === 'cancelled' || turn.status === 'failed' ? (
        <div className="paper-chat-status">
          <span>{turn.status === 'cancelled' ? '已停止' : '回答失败'}</span>
          {props.retryable ? <Button type="link" size="small" onClick={props.onRetry}>重试</Button> : null}
        </div>
      ) : null}
      </div>
      <Modal title="删除聊天" open={confirming} okText="删除" cancelText="取消" okButtonProps={{ danger: true, disabled: props.deleteDisabled }} confirmLoading={deleting}
        onOk={() => void remove()} onCancel={() => { if (!deleting) setConfirming(false) }}>
        <p>确定删除这条问题及回复吗？删除后无法恢复。</p>
        <p className="paper-chat-delete-question">{turn.question}</p>
        {deleteError ? <p role="alert">{deleteError}</p> : null}
      </Modal>
    </article>
  )
}

function SelectionLabel(props: { view: 'original' | 'translated'; text: string; pageIndex?: number | null }): React.JSX.Element {
  const page = props.pageIndex
  return <>
    <span className="paper-chat-pin-source">{props.view === 'original' ? '原文' : '译文'}{page !== undefined && page !== null ? ` · 第 ${page + 1} 页` : ''}</span>
    <span className="paper-chat-pin-text">{props.text.slice(0, 40)}{props.text.length > 40 ? '…' : ''}</span>
  </>
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
