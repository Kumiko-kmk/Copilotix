// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/constants'
import { emptyPaperChatSession, type PaperChatSession, type PaperChatPage } from '@shared/paperChatStorageSchemas'
import { CHAT_CONSENT_VERSION } from '@shared/paperChatSchemas'
import type { AppSettings, ReaderChatSelection } from '@shared/types'
import type { Citation, RagStreamEvent } from '@shared/ragSchemas'
import { usePaperChat } from '../src/renderer/usePaperChat'
import ReaderChatPanel, { ReaderChatToolbar } from '../src/renderer/components/ReaderChatPanel'
import SafeMarkdown from '../src/renderer/components/SafeMarkdown'
import React from 'react'

const doc = '10000000-0000-4000-8000-000000000001'
const requestId = '10000000-0000-4000-8000-000000000002'
const citation: Citation = { citationId: '10000000-0000-4000-8000-000000000003', evidenceId: 'E1', documentId: doc, chunkId: 'chunk1', excerpt: 'source text', scoreProvenance: [{ source: 'full-text', rank: 1, score: 1 }], locator: { documentId: doc, artifactId: '10000000-0000-4000-8000-000000000004', contentRevisionId: 'revision1', contentHash: 'a'.repeat(64), mappingIds: ['m1'], pageStart: 0, pageEnd: 0, sourceStartOffset: 0, sourceEndOffset: 11, offsetUnit: 'utf16' } }
const selection: ReaderChatSelection = { taskId: doc, view: 'original', text: 'source text', fragments: [{ blockKey: 'block1', mappingIds: ['m1'], quote: 'source text', startOffset: 0, endOffset: 11, pageIndex: 0 }] }
const clients: QueryClient[] = []
afterEach(() => { cleanup(); clients.splice(0).forEach((client) => client.clear()); vi.restoreAllMocks() })

function setup(consented = true, configured = true) {
  let listener: ((event: RagStreamEvent) => void) | undefined
  let settings: AppSettings = { ...DEFAULT_SETTINGS, outputRoot: 'C:/papers', chatProvider: null, chatConsentVersion: consented ? CHAT_CONSENT_VERSION : null, credentials: { ...DEFAULT_SETTINGS.credentials, qwen: { state: configured ? 'valid' : 'missing' } } }
  const sessions = new Map<string, PaperChatSession>()
  const load = vi.fn(async (_request: { documentId: string; before?: string }): Promise<PaperChatPage> => ({ turns: [], next: null }))
  const session = vi.fn(async ({ documentId }: { documentId: string }) => sessions.get(documentId) ?? emptyPaperChatSession())
  const saveSession = vi.fn(async ({ documentId, session }: { documentId: string; session: PaperChatSession }) => { sessions.set(documentId, session); return { saved: true as const } })
  const clear = vi.fn(async () => ({ cleared: true as const }))
  const ask = vi.fn(async () => ({ requestId }))
  const cancel = vi.fn(async () => ({ cancelled: true }))
  const ensureIndex = vi.fn(async () => ({ state: 'ready' as const, progress: 100, contentRevisionId: 'revision1' }))
  const unsubscribe = vi.fn()
  const onSelect = vi.fn()
  const onOpenSettings = vi.fn()
  Object.defineProperty(window, 'copilotix', { configurable: true, value: {
    getSettings: vi.fn(async () => settings),
    saveSettings: vi.fn(async (update) => { settings = { ...settings, ...update }; return { settings, fieldErrors: {} } }),
    paperChat: { load, session, saveSession, clear, ask, cancel, ensureIndex, onEvent: (fn: typeof listener) => { listener = fn; return unsubscribe } }
  } })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }); clients.push(client)
  function Harness(props: { documentId: string }) {
    const chat = usePaperChat(props.documentId)
    const [visible, setVisible] = React.useState(true)
    return <><button onClick={() => void chat.addSelection({ ...selection, taskId: props.documentId })}>添加选区</button><button onClick={chat.stop}>关闭面板</button><button onClick={() => setVisible((value) => !value)}>切换面板显示</button>{visible ? <><ReaderChatToolbar chat={chat} /><ReaderChatPanel documentId={props.documentId} chat={chat} active onSelect={onSelect} onOpenSettings={onOpenSettings} /></> : null}</>
  }
  const view = render(<QueryClientProvider client={client}><Harness documentId={doc} /></QueryClientProvider>)
  const emit = (event: RagStreamEvent): void => { act(() => listener?.(event)) }
  const input = async (): Promise<void> => {
    await waitFor(() => expect((screen.getByRole('button', { name: /^发\s*送$/u }) as HTMLButtonElement).disabled).toBe(true))
    fireEvent.change(screen.getByLabelText('向当前论文提问'), { target: { value: '论文主要贡献？' } })
    await waitFor(() => expect((screen.getByRole('button', { name: /^发\s*送$/u }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: /^发\s*送$/u }))
  }
  const complete = (): void => {
    emit({ requestId, sequence: 0, type: 'accepted' }); emit({ requestId, sequence: 1, type: 'retrieving' }); emit({ requestId, sequence: 2, type: 'evidence-ready', resultCount: 1 });
    emit({ requestId, sequence: 3, type: 'delta', delta: '回答 [E1]' }); emit({ requestId, sequence: 4, type: 'citation', citation }); emit({ requestId, sequence: 5, type: 'completed', answer: '回答 [E1]', citationIds: [citation.citationId] })
  }
  return { view, client, Harness, load, session, saveSession, clear, settings, ask, cancel, ensureIndex, unsubscribe, onSelect, onOpenSettings, emit, input, complete }
}

async function chooseModel(label: string): Promise<void> {
  fireEvent.mouseDown(await screen.findByRole('combobox', { name: '问答模型' }))
  fireEvent.click(await screen.findByTitle(label))
}

function shownModel(): string | null {
  return document.querySelector('.reader-chat-model .ant-select-selection-item')?.getAttribute('title') ?? null
}

async function openMenu(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: '更多问答操作' }))
  await screen.findByRole('menu')
}

describe('ReaderChatPanel and local paper sessions', () => {
  it('adds and removes pins, sends a bounded selection snapshot, streams and navigates verified citations', async () => {
    const f = setup()
    fireEvent.click(screen.getByRole('button', { name: '添加选区' }))
    await screen.findByText('source text')
    expect(screen.getByText('原文 · 第 1 页')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '移除选区 1' })); expect(screen.queryByText('source text')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '添加选区' })); await screen.findByText('source text')
    await f.input(); await waitFor(() => expect(f.ask).toHaveBeenCalled())
    expect(f.ask).toHaveBeenCalledWith(expect.objectContaining({ documentId: doc, pinned: [expect.objectContaining({ contentRevisionId: 'revision1', text: 'source text' })] }))
    f.complete()
    fireEvent.click(screen.getByRole('button', { name: '引用 1' }))
    await waitFor(() => expect(f.onSelect).toHaveBeenCalledWith({ mappingId: 'm1', origin: 'citation' }))
    f.ensureIndex.mockResolvedValueOnce({ state: 'ready', progress: 100, contentRevisionId: 'new-revision' })
    fireEvent.click(screen.getByRole('button', { name: '引用 1' }))
    await screen.findByText('来源已更新，请重新提问')
    expect(f.onSelect).toHaveBeenCalledTimes(1)
  })
  it('rejects duplicate and out-of-order events, stops immediately, and ignores late deltas', async () => {
    const f = setup(); await f.input(); await waitFor(() => expect(f.ask).toHaveBeenCalled())
    f.emit({ requestId, sequence: 0, type: 'accepted' }); f.emit({ requestId, sequence: 1, type: 'retrieving' }); f.emit({ requestId, sequence: 2, type: 'evidence-ready', resultCount: 1 });
    f.emit({ requestId, sequence: 3, type: 'delta', delta: 'first' }); f.emit({ requestId, sequence: 3, type: 'delta', delta: 'duplicate' })
    expect(screen.queryByText('firstduplicate')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /停\s*止/u }))
    await waitFor(() => expect(f.cancel).toHaveBeenCalledWith({ requestId }))
    f.emit({ requestId, sequence: 4, type: 'delta', delta: 'late' })
    expect(screen.getByText('已停止')).toBeTruthy(); expect(screen.queryByText('firstlate')).toBeNull()
  })
  it('requires consent before any ask and sends only after the chosen provider is confirmed', async () => {
    const f = setup(false); await f.input()
    await screen.findByText('同意发送论文片段')
    expect(f.ask).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /取\s*消/u }))
    expect(f.ask).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /^发\s*送$/u }))
    fireEvent.click(await screen.findByRole('button', { name: '同意并发送' }))
    await waitFor(() => expect(f.ask).toHaveBeenCalledTimes(1))
    expect(window.copilotix.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ chatProvider: null, chatConsentVersion: CHAT_CONSENT_VERSION }))
  })
  it('offers model setup and clears pins/conversation when switching papers', async () => {
    const f = setup(true, false)
    fireEvent.click(await screen.findByRole('button', { name: '前往设置' })); expect(f.onOpenSettings).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '添加选区' })); await screen.findByText('source text')
    const nextDoc = '10000000-0000-4000-8000-000000000099'
    f.view.rerender(<QueryClientProvider client={f.client}><f.Harness documentId={nextDoc} /></QueryClientProvider>)
    await waitFor(() => expect(screen.queryByText('source text')).toBeNull())
    expect(f.unsubscribe).toHaveBeenCalled()
    expect(f.ask).not.toHaveBeenCalled()
  })
  it('cancels an active request when the panel closes and removes the subscription on unmount', async () => {
    const f = setup(); await f.input(); await waitFor(() => expect(f.ask).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: '关闭面板' })); expect(f.cancel).toHaveBeenCalledWith({ requestId })
    f.view.unmount(); expect(f.unsubscribe).toHaveBeenCalled()
  })
  it('buffers events until ask returns the matching identity and rejects unrelated early events', async () => {
    const f = setup()
    let finish!: (value: { requestId: string }) => void
    f.ask.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    await f.input(); await waitFor(() => expect(f.ask).toHaveBeenCalled())
    f.emit({ requestId: doc, sequence: 0, type: 'accepted' })
    f.emit({ requestId: doc, sequence: 1, type: 'retrieving' })
    f.complete()
    expect(screen.queryByText('回答')).toBeNull()
    await act(async () => { finish({ requestId }) })
    expect(screen.getByRole('button', { name: '引用 1' })).toBeTruthy()
  })
  it('cancels an ask that resolves after the reader is unmounted', async () => {
    const f = setup()
    let finish!: (value: { requestId: string }) => void
    f.ask.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    await f.input(); await waitFor(() => expect(f.ask).toHaveBeenCalled())
    f.view.unmount()
    await act(async () => { finish({ requestId }) })
    expect(f.cancel).toHaveBeenCalledWith({ requestId })
  })
  it('sanitizes scripts and math and prevents answer images/links from making external requests', () => {
    const view = render(<SafeMarkdown markdown={'<script>window.evil()</script>\n\n<img src="https://attacker.test" onerror="alert(1)"/>\n\n[external](https://attacker.test) [bad](javascript:alert(1)) $x^2$ [E99]'} citations={{}} />)
    expect(view.container.querySelector('script,img,a')).toBeNull()
    expect(view.container.querySelector('.katex')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'E99' })).toBeNull()
  })
  it('switches the model inside chat using the existing translation API without saving API settings', async () => {
    const f = setup()
    await waitFor(() => expect(shownModel()).toBe('qwen-plus'))
    expect(screen.getByText('Qwen')).toBeTruthy()
    await chooseModel('qwen3.8-flash')
    await waitFor(() => expect(shownModel()).toBe('qwen3.8-flash'))
    await f.input(); await waitFor(() => expect(f.ask).toHaveBeenCalledWith(expect.objectContaining({ model: 'qwen3.8-flash' })))
    expect(window.copilotix.saveSettings).not.toHaveBeenCalled()
    expect(document.querySelector('.reader-chat-model')?.classList.contains('ant-select-disabled')).toBe(true)
  })
  it('offers only preset models and revokes consent directly in chat', async () => {
    const f = setup()
    await chooseModel('qwen3.8-flash')
    expect(screen.queryByText('自定义模型…')).toBeNull()
    expect(screen.queryByLabelText('模型名称')).toBeNull()
    fireEvent.change(screen.getByLabelText('向当前论文提问'), { target: { value: '问题' } })
    await openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: '撤销发送授权' }))
    await waitFor(() => expect(window.copilotix.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ chatConsentVersion: null })))
    await openMenu()
    await waitFor(() => expect(screen.queryByRole('menuitem', { name: '撤销发送授权' })).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: /^发\s*送$/u }))
    fireEvent.click(await screen.findByRole('button', { name: '同意并发送' }))
    await waitFor(() => expect(f.ask).toHaveBeenCalledWith(expect.objectContaining({ model: 'qwen3.8-flash' })))
  })
  it('keeps the model when reopening chat and resets it when switching papers', async () => {
    const f = setup()
    await chooseModel('qwen3.8-flash')
    fireEvent.click(screen.getByRole('button', { name: '切换面板显示' }))
    expect(screen.queryByRole('combobox', { name: '问答模型' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '切换面板显示' }))
    await waitFor(() => expect(shownModel()).toBe('qwen3.8-flash'))
    f.view.rerender(<QueryClientProvider client={f.client}><f.Harness documentId="10000000-0000-4000-8000-000000000099" /></QueryClientProvider>)
    await waitFor(() => expect(shownModel()).toBe('qwen-plus'))
  })
  it('sends with Enter, keeps Shift+Enter and IME composition as input, and fills suggestions', async () => {
    const f = setup()
    fireEvent.click(await screen.findByRole('button', { name: '总结这篇论文的主要贡献' }))
    const question = screen.getByLabelText('向当前论文提问') as HTMLTextAreaElement
    expect(question.value).toBe('总结这篇论文的主要贡献')
    await waitFor(() => expect((screen.getByRole('button', { name: /^发\s*送$/u }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.keyDown(question, { key: 'Enter', shiftKey: true })
    fireEvent.keyDown(question, { key: 'Enter', isComposing: true })
    expect(f.ask).not.toHaveBeenCalled()
    fireEvent.keyDown(question, { key: 'Enter' })
    await waitFor(() => expect(f.ask).toHaveBeenCalledWith(expect.objectContaining({ question: '总结这篇论文的主要贡献' })))
    expect(question.value).toBe('')
  })
  it('previews citation excerpts on hover and clears the conversation from the menu', async () => {
    const f = setup(); await f.input(); await waitFor(() => expect(f.ask).toHaveBeenCalled())
    f.complete()
    fireEvent.mouseEnter(screen.getByRole('button', { name: '引用 1' }))
    expect(await screen.findByText('第 1 页')).toBeTruthy()
    expect(screen.getAllByText('source text').length).toBeGreaterThan(0)
    await openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: '清空对话' }))
    await waitFor(() => expect(screen.queryByRole('log', { name: '问答记录' })).toBeNull())
    expect(screen.getByRole('button', { name: '总结这篇论文的主要贡献' })).toBeTruthy()
  })
  it('selects DeepSeek independently from the translation provider and sends the selected model', async () => {
    const f = setup()
    f.settings.credentials.deepseek = { state: 'valid' }
    fireEvent.mouseDown(await screen.findByRole('combobox', { name: '问答服务商' }))
    fireEvent.click(await screen.findByTitle('DeepSeek'))
    await waitFor(() => expect(shownModel()).toBe('deepseek-flash'))
    await chooseModel('deepseek-v4-pro')
    await f.input()
    expect(f.ask).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: '同意并发送' }))
    await waitFor(() => expect(f.ask).toHaveBeenCalledWith(expect.objectContaining({ provider: 'deepseek', model: 'deepseek-v4-pro' })))
    expect(f.settings.translationProvider).toBe('qwen')
  })
  it('restores paper-local turns and keeps its draft and model after leaving and reopening the reader', async () => {
    const f = setup()
    await waitFor(() => expect(shownModel()).toBe('qwen-plus'))
    const stored = { id: requestId, createdAt: new Date().toISOString(), provider: 'qwen' as const, model: 'qwen-plus', question: '已保存的问题', answer: '已保存的回答 [E1]', status: 'completed' as const, citations: { E1: citation } }
    f.load.mockResolvedValue({ turns: [stored], next: null })
    fireEvent.change(screen.getByLabelText('向当前论文提问'), { target: { value: '待发送草稿' } })
    await chooseModel('qwen3.8-flash')
    f.view.unmount()
    render(<QueryClientProvider client={f.client}><f.Harness documentId={doc} /></QueryClientProvider>)
    await screen.findByText('已保存的问题')
    expect((screen.getByLabelText('向当前论文提问') as HTMLTextAreaElement).value).toBe('待发送草稿')
    expect(shownModel()).toBe('qwen3.8-flash')
    expect(screen.getByRole('button', { name: '引用 1' })).toBeTruthy()
    await f.input()
    await waitFor(() => expect(f.ask).toHaveBeenCalledWith(expect.objectContaining({ history: [{ role: 'user', content: stored.question }, { role: 'assistant', content: stored.answer }] })))
  })
  it('loads older turns and refuses to overwrite history when disk loading fails', async () => {
    const f = setup()
    await waitFor(() => expect(shownModel()).toBe('qwen-plus'))
    const stored = { id: requestId, createdAt: new Date().toISOString(), provider: 'qwen' as const, model: 'qwen-plus', question: '最近问题', answer: '回答', status: 'completed' as const, citations: {} }
    f.load.mockResolvedValueOnce({ turns: [stored], next: '1790000000000-10000000-0000-4000-8000-000000000002.json' })
      .mockResolvedValueOnce({ turns: [{ ...stored, question: '更早问题' }], next: null })
    f.view.unmount()
    const view = render(<QueryClientProvider client={f.client}><f.Harness documentId={doc} /></QueryClientProvider>)
    fireEvent.click(await screen.findByRole('button', { name: '查看更早的对话' }))
    await screen.findByText('更早问题')
    expect(f.load).toHaveBeenLastCalledWith(expect.objectContaining({ before: expect.any(String) }))
    view.unmount()
    f.load.mockRejectedValue(new Error('broken file')); f.saveSession.mockClear()
    render(<QueryClientProvider client={f.client}><f.Harness documentId={doc} /></QueryClientProvider>)
    await screen.findByText('本地对话读取失败，请重新打开论文；原记录未被覆盖')
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(f.saveSession).not.toHaveBeenCalled()
  })

})
