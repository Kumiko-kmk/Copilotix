import React from 'react'
import { canTransitionRagStreamEvent, type Citation, type RagStreamEventType, type RagStreamEvent } from '@shared/ragSchemas'
import { paperChatPinnedSchema, supportedChatModelSchema, type PaperChatProvider } from '@shared/paperChatSchemas'
import type { ReaderChatSelection } from '@shared/types'
import { emptyPaperChatSession, type PaperChatSession } from '@shared/paperChatStorageSchemas'

export interface PaperChatTurn { question: string; answer: string; citations: Record<string, Citation>; status: 'pending' | 'completed' | 'failed' | 'cancelled' }

export function usePaperChat(documentId: string) {
  const [sessionState, setSessionState] = React.useState({ documentId, session: emptyPaperChatSession(), ready: false })
  const sessionRef = React.useRef(sessionState)
  sessionRef.current = sessionState
  const session = sessionState.documentId === documentId ? sessionState.session : emptyPaperChatSession()
  const { pinned, draft, selectedModel } = session
  const updateSession = React.useCallback((patch: Partial<PaperChatSession>) => {
    setSessionState((state) => state.documentId === documentId ? { ...state, session: { ...state.session, ...patch } } : state)
  }, [documentId])
  const setDraft = React.useCallback((draft: string) => updateSession({ draft }), [updateSession])
  const setSelectedModel = React.useCallback((selectedModel: PaperChatSession['selectedModel']) => updateSession({ selectedModel }), [updateSession])
  const [turns, setTurns] = React.useState<PaperChatTurn[]>([])
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [loading, setLoading] = React.useState(true)
  const [next, setNext] = React.useState<string | null>(null)
  const [loadingOlder, setLoadingOlder] = React.useState(false)
  const documentEpoch = React.useRef(0)
  const hydration = React.useRef<Promise<void>>(Promise.resolve())
  const active = React.useRef<{ requestId: string | null; pending: boolean; sequence: number; type: RagStreamEventType | null; epoch: number; buffered: RagStreamEvent[] }>({ requestId: null, pending: false, sequence: -1, type: null, epoch: 0, buffered: [] })
  const receive = React.useRef<(event: RagStreamEvent) => void>(() => undefined)
  const stop = React.useCallback(() => {
    const current = active.current
    if (current.requestId) void window.copilotix.paperChat.cancel({ requestId: current.requestId }).catch(() => undefined)
    current.epoch++; current.pending = false; current.requestId = null; current.buffered = []
    setBusy(false)
    setTurns((items) => items.map((t) => t.status === 'pending' ? { ...t, status: 'cancelled' } : t))
  }, [])

  React.useEffect(() => {
    const state = active.current
    state.epoch++; state.requestId = null; state.pending = false; state.buffered = []
    const epoch = ++documentEpoch.current
    setSessionState({ documentId, session: emptyPaperChatSession(), ready: false })
    setTurns([]); setBusy(false); setError(''); setLoading(true); setNext(null); setLoadingOlder(false)
    hydration.current = Promise.all([
      window.copilotix.paperChat.load({ documentId }),
      window.copilotix.paperChat.session({ documentId })
    ]).then(([page, session]) => {
      if (documentEpoch.current !== epoch) return
      setTurns(page.turns); setNext(page.next)
      setSessionState({ documentId, session, ready: true })
    }).catch(() => {
      if (documentEpoch.current === epoch) setError('本地对话读取失败，请重新打开论文；原记录未被覆盖')
    }).finally(() => { if (documentEpoch.current === epoch) setLoading(false) })
    receive.current = (event) => {
      const current = active.current
      if (current.pending && !current.requestId) { if (current.buffered.length < 512) current.buffered.push(event); return }
      if (event.requestId !== current.requestId || event.sequence <= current.sequence || !canTransitionRagStreamEvent(current.type, event.type)) return
      current.sequence = event.sequence; current.type = event.type
      setTurns((items) => items.map((turn, index) => {
        if (index !== items.length - 1 || turn.status !== 'pending') return turn
        if (event.type === 'delta') return { ...turn, answer: turn.answer + event.delta }
        if (event.type === 'citation' && event.citation.evidenceId) return { ...turn, citations: { ...turn.citations, [event.citation.evidenceId]: event.citation } }
        if (event.type === 'completed') return { ...turn, answer: event.answer ?? turn.answer, status: 'completed' }
        if (event.type === 'failed' || event.type === 'cancelled') return { ...turn, status: event.type }
        return turn
      }))
      if (['completed', 'failed', 'cancelled'].includes(event.type)) {
        current.pending = false; current.requestId = null; current.buffered = []; setBusy(false)
        if (event.type === 'failed') setError(event.error.message)
      }
    }
    const unsubscribe = window.copilotix.paperChat.onEvent((event) => receive.current(event))
    const saveBeforeLeaving = (): void => {
      const saved = sessionRef.current
      if (saved.documentId === documentId && saved.ready) void window.copilotix.paperChat.saveSession({ documentId, session: saved.session }).catch(() => undefined)
    }
    window.addEventListener('pagehide', saveBeforeLeaving)
    return () => {
      documentEpoch.current++
      saveBeforeLeaving()
      window.removeEventListener('pagehide', saveBeforeLeaving)
      unsubscribe()
      state.epoch++; state.pending = false; state.buffered = []
      if (state.requestId) void window.copilotix.paperChat.cancel({ requestId: state.requestId }).catch(() => undefined)
      state.requestId = null
    }
  }, [documentId])

  React.useEffect(() => {
    if (!sessionState.ready || sessionState.documentId !== documentId) return
    const epoch = documentEpoch.current
    const timer = setTimeout(() => {
      void window.copilotix.paperChat.saveSession({ documentId, session: sessionState.session }).catch(() => {
        if (documentEpoch.current === epoch) setError('对话草稿保存失败，请检查文献目录')
      })
    }, 200)
    return () => clearTimeout(timer)
  }, [documentId, sessionState])

  const loadOlder = React.useCallback(async () => {
    if (!next || loadingOlder) return
    const epoch = documentEpoch.current
    setLoadingOlder(true)
    try {
      const page = await window.copilotix.paperChat.load({ documentId, before: next })
      if (documentEpoch.current !== epoch) return
      setTurns((items) => [...page.turns, ...items]); setNext(page.next)
    } catch { if (documentEpoch.current === epoch) setError('较早对话读取失败，请重试') }
    finally { if (documentEpoch.current === epoch) setLoadingOlder(false) }
  }, [documentId, loadingOlder, next])

  const pinnedCount = React.useRef(0)
  pinnedCount.current = pinned.length

  /** Resolves to null once the selection is pinned, otherwise to the reason it was not. */
  const addSelection = React.useCallback(async (selection: ReaderChatSelection): Promise<string | null> => {
    const generation = documentEpoch.current
    await hydration.current
    if (documentEpoch.current !== generation) return '论文已切换'
    const epoch = active.current.epoch
    if (selection.taskId !== documentId) return '选区不属于当前论文'
    const fail = (reason: string): string => { setError(reason); return reason }
    if (pinnedCount.current >= 8) return fail('最多添加 8 个选区')
    try {
      const status = await window.copilotix.paperChat.ensureIndex({ documentId })
      if (epoch !== active.current.epoch) return '论文已切换'
      if (status.state !== 'ready' || !status.contentRevisionId) return fail('论文正在准备索引，请稍后重新添加选区')
      const pin = paperChatPinnedSchema.parse({ view: selection.view, text: selection.text, contentRevisionId: status.contentRevisionId, fragments: selection.fragments.map(({ blockKey: _blockKey, ...fragment }) => fragment) })
      if (pinnedCount.current >= 8) return fail('最多添加 8 个选区')
      pinnedCount.current += 1
      setSessionState((state) => ({ ...state, session: { ...state.session, pinned: [...state.session.pinned, pin].slice(0, 8) } }))
      return null
    } catch { return fail('选区无法加入问答，请缩小范围后重试') }
  }, [documentId])

  const ask = React.useCallback(async (question: string, model?: string, provider?: PaperChatProvider) => {
    const generation = documentEpoch.current
    await hydration.current
    if (documentEpoch.current !== generation) return
    if (!sessionRef.current.ready || sessionRef.current.documentId !== documentId) return
    if (active.current.pending || !question.trim()) return
    const state = active.current
    const epoch = ++state.epoch
    state.pending = true; state.requestId = null; state.buffered = []; state.sequence = -1; state.type = null
    setBusy(true); setError('')
    setTurns((items) => [...items, { question, answer: '', citations: {}, status: 'pending' }])
    const history = turns.filter((t) => t.status === 'completed').slice(-6).flatMap((t) => [
      { role: 'user' as const, content: t.question.slice(0, 2_000) },
      { role: 'assistant' as const, content: t.answer.slice(0, 2_000) }
    ])
    try {
      const { requestId } = await window.copilotix.paperChat.ask({ documentId, question, pinned, history, ...(model ? { model: supportedChatModelSchema.parse(model) } : {}), ...(provider ? { provider } : {}) })
      if (epoch !== state.epoch) { void window.copilotix.paperChat.cancel({ requestId }).catch(() => undefined); return }
      if (state.pending) {
        state.requestId = requestId
        const buffered = state.buffered; state.buffered = []
        for (const event of buffered) receive.current(event)
      }
    } catch (e) {
      if (epoch !== state.epoch) return
      state.pending = false; state.requestId = null; setBusy(false)
      setError(e instanceof Error ? e.message : '问答失败，请重试')
      setTurns((items) => items.map((t, i) => i === items.length - 1 ? { ...t, status: 'failed' } : t))
    }
  }, [documentId, pinned, turns])

  const clear = React.useCallback(async () => {
    const epoch = ++documentEpoch.current
    if (active.current.pending) stop()
    setLoading(true)
    try {
      await window.copilotix.paperChat.clear({ documentId })
      if (documentEpoch.current !== epoch) return
      setTurns([]); setNext(null); setError('')
    } catch { if (documentEpoch.current === epoch) setError('清空本地对话失败，请重试') }
    finally { if (documentEpoch.current === epoch) setLoading(false) }
  }, [documentId, stop])

  return {
    pinned, turns, busy, error, loaded: sessionState.ready && sessionState.documentId === documentId, loading, next, loadingOlder, loadOlder, selectedModel, setSelectedModel, draft, setDraft, ask, stop, clear, addSelection,
    removePin: (index: number) => updateSession({ pinned: pinned.filter((_, i) => i !== index) })
  }
}

export type PaperChatController = ReturnType<typeof usePaperChat>
