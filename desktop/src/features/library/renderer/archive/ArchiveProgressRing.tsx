import React from 'react'

const completed = new Set<string>()
const keyFor = (id: string): string => `copilotix.archive-complete.v1:${id}`
function wasCompleted(id: string): boolean {
  if (completed.has(id)) return true
  try { if (localStorage.getItem(keyFor(id)) === '1') { completed.add(id); return true } } catch { /* Session fallback. */ }
  return false
}

/** One success animation per document, durable across navigation and app restarts. */
export default function ArchiveProgressRing({ documentId, progress, ready }: { documentId: string; progress: number; ready: boolean }): React.JSX.Element | null {
  const [phase, setPhase] = React.useState<'progress' | 'success' | 'hidden'>(() => wasCompleted(documentId) ? 'hidden' : 'progress')
  React.useEffect(() => {
    if (!ready || phase !== 'progress') return
    completed.add(documentId)
    try { localStorage.setItem(keyFor(documentId), '1') } catch { /* Session fallback. */ }
    setPhase('success')
  }, [ready, phase, documentId])
  React.useEffect(() => {
    if (phase !== 'success') return
    const timer = window.setTimeout(() => setPhase('hidden'), 1300)
    return () => window.clearTimeout(timer)
  }, [phase])
  if (phase === 'hidden') return null
  const value = Math.min(100, Math.max(0, progress))
  return <span className={`paper-archive-progress ${phase}`} data-progress-phase={phase}
    role={phase === 'progress' ? 'progressbar' : 'img'} aria-label={phase === 'progress' ? '后台处理进度' : '处理完成'}
    aria-valuenow={phase === 'progress' ? Math.floor(value) : undefined} aria-valuemin={phase === 'progress' ? 0 : undefined} aria-valuemax={phase === 'progress' ? 100 : undefined}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><circle className="track" cx="12" cy="12" r="10" />
      <circle className="arc" cx="12" cy="12" r="10" style={{ strokeDashoffset: 62.832 * (1 - value / 100) }} />
      <path className="check" d="M5.8 12.2 10.1 16.4 18.3 7.7" /></svg>
  </span>
}
