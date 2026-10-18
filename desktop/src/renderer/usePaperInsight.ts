import React from 'react'
import type { PaperInsightSource, PaperInsightState } from '@shared/paperInsight'

/** Keeps the saved card readable while a replacement is generated. */
export function usePaperInsight(documentId: string, source?: PaperInsightSource) {
  const [state, setState] = React.useState<PaperInsightState | null>(null)
  const [ready, setReady] = React.useState<Extract<PaperInsightState, { status: 'ready' }> | null>(null)
  const generation = React.useRef(0)
  React.useEffect(() => {
    const version = ++generation.current
    let updated = false
    setState(null)
    setReady(null)
    if (!source) return
    const accept = (next: PaperInsightState): void => {
      if (generation.current !== version) return
      setState(next)
      if (next.status === 'ready') setReady(next)
    }
    const stop = source.subscribe((id, next) => { if (id === documentId) { updated = true; accept(next) } })
    source.get(documentId).then((next) => { if (!updated) accept(next) }, () => {
      if (!updated) accept({ status: 'failed', error: '无法读取本地档案卡，请重试。' })
    })
    return () => { generation.current++; stop() }
  }, [documentId, source])
  const generate = (): void => {
    if (!source) return
    const version = generation.current
    setState({ status: 'generating' })
    source.generate(documentId).catch(() => {
      if (generation.current === version) setState({ status: 'failed', error: '无法开始生成，请稍后重试。' })
    })
  }
  return { state, ready, generate }
}
