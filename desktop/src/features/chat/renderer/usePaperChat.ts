import React from 'react'
import { canTransitionRagStreamEvent, type Citation, type RagStreamEventType, type RagStreamEvent } from '../contract/ragSchemas'
import { paperChatPinnedSchema, supportedChatModelSchema, type PaperChatPinned, type PaperChatProvider } from '../contract/paperChatSchemas'
import type { ReaderChatSelection } from '@features/reader/contract/readerTypes'
import { emptyPaperChatSession, paperChatTurnSelections, type PaperChatSession, type StoredPaperChatTurn } from '../contract/paperChatStorageSchemas'
import { PAPER_CHAT_MAX_FIGURES, paperChatFigurePinSchema, type PaperChatFigurePin } from '../contract/paperChatFigures'

export interface PaperChatTurn extends Partial<Pick<StoredPaperChatTurn, 'id' | 'model' | 'provider' | 'createdAt' | 'completedAt' | 'durationMs' | 'usage' | 'selections' | 'figures'>> {
  /** The selections sent with this question, kept in memory so a retry asks about them again. */
  pinned?: PaperChatPinned[]
  /** Figures sent with a question asked in this session; stored turns carry `figures` instead. */
  figurePins?: PaperChatFigurePin[]
  question: string; answer: string; citations: Record<string, Citation>; status: 'pending' | 'completed' | 'failed' | 'cancelled' }

export function usePaperChat(documentId: string) {
  const [sessionState, setSessionState] = React.useState({ documentId, session: emptyPaperChatSession(), ready: false })
  const sessionRef = React.useRef(sessionState)
  sessionRef.current = sessionState
  const session = sessionState.documentId === documentId ? sessionState.session : emptyPaperChatSession()
  const { pinned, draft, selectedModel } = session
  const figures = session.figures ?? NO_FIGURES
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
      if (documentEpoch.current === epoch) setError('本地對話讀取失敗，請重新開啟論文；原記錄未被覆蓋')
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
        if (event.type === 'completed') return { ...turn, answer: event.answer ?? turn.answer, ...event.metadata, status: 'completed' }
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
        if (documentEpoch.current === epoch) setError('對話草稿儲存失敗，請檢查文獻目錄')
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
    } catch { if (documentEpoch.current === epoch) setError('較早對話讀取失敗，請重試') }
    finally { if (documentEpoch.current === epoch) setLoadingOlder(false) }
  }, [documentId, loadingOlder, next])

  const pinnedCount = React.useRef(0)
  pinnedCount.current = pinned.length

  /** Resolves to null once the selection is pinned, otherwise to the reason it was not. */
  const addSelection = React.useCallback(async (selection: ReaderChatSelection): Promise<string | null> => {
    const generation = documentEpoch.current
    await hydration.current
    if (documentEpoch.current !== generation) return '論文已切換'
    const epoch = active.current.epoch
    if (selection.taskId !== documentId) return '選區不屬於當前論文'
    const fail = (reason: string): string => { setError(reason); return reason }
    if (pinnedCount.current >= 8) return fail('最多新增 8 個選區')
    try {
      const status = await window.copilotix.paperChat.ensureIndex({ documentId })
      if (epoch !== active.current.epoch) return '論文已切換'
      if (status.state !== 'ready' || !status.contentRevisionId) return fail('論文正在準備索引，請稍後重新新增選區')
      const pin = paperChatPinnedSchema.parse({ view: selection.view, text: selection.text, contentRevisionId: status.contentRevisionId, fragments: selection.fragments.map(({ blockKey: _blockKey, ...fragment }) => fragment) })
      if (pinnedCount.current >= 8) return fail('最多新增 8 個選區')
      pinnedCount.current += 1
      setSessionState((state) => ({ ...state, session: { ...state.session, pinned: [...state.session.pinned, pin].slice(0, 8) } }))
      return null
    } catch { return fail('選區無法加入問答，請縮小範圍後重試') }
  }, [documentId])

  /** Resolves to null once the figure waits in the composer, otherwise to the reason it was not added. */
  const addFigure = React.useCallback(async (raw: PaperChatFigurePin): Promise<string | null> => {
    const generation = documentEpoch.current
    await hydration.current
    if (documentEpoch.current !== generation || sessionRef.current.documentId !== documentId) return '論文已切換'
    const pin = paperChatFigurePinSchema.parse(raw)
    const current = sessionRef.current.session.figures ?? []
    if (current.some((figure) => figure.figureId === pin.figureId)) return '這張圖已在 Chat 中'
    if (current.length >= PAPER_CHAT_MAX_FIGURES) return `每次提問最多附帶 ${PAPER_CHAT_MAX_FIGURES} 張圖`
    setSessionState((state) => state.documentId === documentId ? { ...state, session: { ...state.session, figures: [...(state.session.figures ?? []), pin] } } : state)
    return null
  }, [documentId])

  /** Sends the composer's selections and figures unless given (a retry); they move into the turn. */
  const ask = React.useCallback(async (question: string, model?: string, provider?: PaperChatProvider, pins?: readonly PaperChatPinned[], figurePins?: readonly PaperChatFigurePin[]) => {
    const generation = documentEpoch.current
    await hydration.current
    if (documentEpoch.current !== generation) return
    if (!sessionRef.current.ready || sessionRef.current.documentId !== documentId) return
    if (active.current.pending || !question.trim()) return
    const sent = [...(pins ?? pinned)]
    const sentFigures = [...(figurePins ?? figures)]
    if (!pins && sent.length) updateSession({ pinned: [] })
    if (!figurePins && sentFigures.length) updateSession({ figures: [] })
    const state = active.current
    const epoch = ++state.epoch
    state.pending = true; state.requestId = null; state.buffered = []; state.sequence = -1; state.type = null
    setBusy(true); setError('')
    const localCreatedAt = new Date().toISOString()
    setTurns((items) => [...items, { question, model, provider, createdAt: localCreatedAt, ...(sent.length ? { pinned: sent, selections: paperChatTurnSelections(sent) } : {}), ...(sentFigures.length ? { figurePins: sentFigures } : {}), answer: '', citations: {}, status: 'pending' }])
    const history = turns.filter((t) => t.status === 'completed').slice(-6).flatMap((t) => [
      // Earlier images are not resent; the label tells the model which figure that turn was about.
      { role: 'user' as const, content: (figureNote(t) + t.question).slice(0, 2_000) },
      { role: 'assistant' as const, content: t.answer.slice(0, 2_000) }
    ])
    try {
      const { requestId, createdAt } = await window.copilotix.paperChat.ask({ documentId, question, pinned: sent, history, ...(model ? { model: supportedChatModelSchema.parse(model) } : {}), ...(provider ? { provider } : {}), ...(sentFigures.length ? { figures: sentFigures } : {}) })
      if (documentEpoch.current === generation) setTurns(items => items.map(turn => turn.createdAt === localCreatedAt && turn.question === question ? { ...turn, id: requestId, createdAt: createdAt ?? localCreatedAt } : turn))
      if (epoch !== state.epoch) { void window.copilotix.paperChat.cancel({ requestId }).catch(() => undefined); return }
      if (state.pending) {
        state.requestId = requestId
        const buffered = state.buffered; state.buffered = []
        for (const event of buffered) receive.current(event)
      }
    } catch (e) {
      if (epoch !== state.epoch) return
      state.pending = false; state.requestId = null; setBusy(false)
      setError(e instanceof Error ? e.message : '問答失敗，請重試')
      setTurns((items) => items.map((t, i) => i === items.length - 1 ? { ...t, status: 'failed' } : t))
    }
  }, [documentId, figures, pinned, turns, updateSession])

  const deleteTurn = React.useCallback(async (turn: PaperChatTurn): Promise<void> => {
    if (active.current.pending || loadingOlder) throw new Error('請等待當前操作完成後再刪除')
    const epoch = documentEpoch.current
    if (turn.id && turn.createdAt) await window.copilotix.paperChat.deleteTurn({ documentId, turnId: turn.id, createdAt: turn.createdAt })
    if (documentEpoch.current !== epoch) return
    setTurns(items => items.filter(item => turn.id ? item.id !== turn.id : item !== turn))
  }, [documentId, loadingOlder])

  const clear = React.useCallback(async () => {
    const epoch = ++documentEpoch.current
    if (active.current.pending) stop()
    setLoading(true)
    try {
      await window.copilotix.paperChat.clear({ documentId })
      if (documentEpoch.current !== epoch) return
      setTurns([]); setNext(null); setError('')
    } catch { if (documentEpoch.current === epoch) setError('清空本地對話失敗，請重試') }
    finally { if (documentEpoch.current === epoch) setLoading(false) }
  }, [documentId, stop])

  return {
    pinned, figures, addFigure, turns, busy, error, loaded: sessionState.ready && sessionState.documentId === documentId, loading, next, loadingOlder, loadOlder, selectedModel, setSelectedModel, draft, setDraft, ask, stop, clear, deleteTurn, addSelection,
    removePin: (index: number) => updateSession({ pinned: pinned.filter((_, i) => i !== index) }),
    removeFigure: (index: number) => updateSession({ figures: figures.filter((_, i) => i !== index) })
  }
}

const NO_FIGURES: PaperChatFigurePin[] = []

/** The figures a turn asked about, as pins that can be sent again. */
export function turnFigurePins(turn: PaperChatTurn): PaperChatFigurePin[] {
  return turn.figurePins ?? turn.figures?.map(({ figureId, label, pageIndex }) => ({ figureId, label, pageIndex })) ?? []
}

function figureNote(turn: PaperChatTurn): string {
  const labels = turnFigurePins(turn).map((figure) => figure.label ?? (figure.pageIndex !== null ? `第 ${figure.pageIndex + 1} 頁的圖` : '一張圖'))
  return labels.length ? `[附圖：${labels.join('、')}] ` : ''
}

export type PaperChatController = ReturnType<typeof usePaperChat>
