import React from 'react'
import { canTransitionRagStreamEvent, type Citation, type RagStreamEventType, type RagStreamEvent } from '@shared/ragSchemas'
import { paperChatPinnedSchema, type PaperChatPinned, type PaperChatProvider } from '@shared/paperChatSchemas'
import type { ReaderChatSelection } from '@shared/types'

export interface PaperChatTurn { question: string; answer: string; citations: Record<string, Citation>; status: 'pending' | 'completed' | 'failed' | 'cancelled' }

export function usePaperChat(documentId: string) {
  const [pinned, setPinned] = React.useState<PaperChatPinned[]>([])
  const [turns, setTurns] = React.useState<PaperChatTurn[]>([])
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [selectedModel, setSelectedModel] = React.useState<{ provider: PaperChatProvider; model: string; custom: boolean } | null>(null)
  // The draft lives with the session so leaving the chat tab never loses it.
  const [draft, setDraft] = React.useState('')
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
    setPinned([]); setTurns([]); setBusy(false); setError(''); setSelectedModel(null); setDraft('')
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
    return () => {
      unsubscribe()
      state.epoch++; state.pending = false; state.buffered = []
      if (state.requestId) void window.copilotix.paperChat.cancel({ requestId: state.requestId }).catch(() => undefined)
      state.requestId = null
    }
  }, [documentId])

  const pinnedCount = React.useRef(0)
  pinnedCount.current = pinned.length

  /** Resolves to null once the selection is pinned, otherwise to the reason it was not. */
  const addSelection = React.useCallback(async (selection: ReaderChatSelection): Promise<string | null> => {
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
      setPinned((items) => [...items, pin].slice(0, 8))
      return null
    } catch { return fail('选区无法加入问答，请缩小范围后重试') }
  }, [documentId])

  const ask = React.useCallback(async (question: string, model?: string) => {
    if (active.current.pending || !question.trim()) return
    const state = active.current
    const epoch = ++state.epoch
    state.pending = true; state.requestId = null; state.buffered = []; state.sequence = -1; state.type = null
    setBusy(true); setError('')
    setTurns((items) => [...items.slice(-11), { question, answer: '', citations: {}, status: 'pending' }])
    const history = turns.filter((t) => t.status === 'completed').slice(-6).flatMap((t) => [
      { role: 'user' as const, content: t.question.slice(0, 2_000) },
      { role: 'assistant' as const, content: t.answer.slice(0, 2_000) }
    ])
    try {
      const { requestId } = await window.copilotix.paperChat.ask({ documentId, question, pinned, history, ...(model ? { model } : {}) })
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

  const clear = React.useCallback(() => {
    if (active.current.pending) stop()
    setTurns([]); setError('')
  }, [stop])

  return {
    pinned, turns, busy, error, selectedModel, setSelectedModel, draft, setDraft, ask, stop, clear, addSelection,
    removePin: (index: number) => setPinned((items) => items.filter((_, i) => i !== index))
  }
}

export type PaperChatController = ReturnType<typeof usePaperChat>
