import React from 'react'
import { loadReaderPage } from '@features/reader/renderer'
import type { PaperArchiveScene } from './PaperArchiveScene'

/** One cancellable entry for the cover, button and keyboard; nothing is persisted. */
export function useArchiveReaderEntry(scene: React.RefObject<PaperArchiveScene | null>, selectedId: string | undefined,
  documentIds: readonly string[], onOpen: (id: string) => void) {
  const [phase, setPhase] = React.useState<'loading' | 'leaving' | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const active = React.useRef<(AbortController & { documentId: string }) | null>(null)
  const current = React.useRef({ documentIds, onOpen })
  current.current = { documentIds, onOpen }

  const cancel = React.useCallback((): boolean => {
    if (!active.current) return false
    const controller = active.current
    active.current = null
    controller.abort()
    scene.current?.cancelReaderEntry()
    setPhase(null)
    return true
  }, [scene])

  React.useLayoutEffect(() => { cancel() }, [selectedId, cancel])
  React.useLayoutEffect(() => () => {
    const controller = active.current
    active.current = null
    controller?.abort()
    scene.current?.cancelReaderEntry()
  }, [scene])
  React.useLayoutEffect(() => {
    const controller = active.current
    if (controller && !current.current.documentIds.includes(controller.documentId)) cancel()
  }, [documentIds, cancel])

  const open = React.useCallback((id: string): void => {
    if (active.current || !current.current.documentIds.includes(id)) return
    const controller = Object.assign(new AbortController(), { documentId: id })
    active.current = controller
    setError(null)
    setPhase('loading')
    const { signal } = controller
    void (async () => {
      let timedOut = false
      const timer = window.setTimeout(() => { timedOut = true; controller.abort() }, 10_000)
      try {
        await new Promise<void>((resolve, reject) => {
          const aborted = (): void => reject(new DOMException('Reader entry cancelled', 'AbortError'))
          signal.addEventListener('abort', aborted, { once: true })
          loadReaderPage().then(() => { signal.removeEventListener('abort', aborted); resolve() }, reason => {
            signal.removeEventListener('abort', aborted)
            reject(reason)
          })
        })
        window.clearTimeout(timer)
        signal.throwIfAborted()
        if (active.current !== controller) return
        setPhase('leaving')
        await scene.current?.enterReader(signal)
        signal.throwIfAborted()
        if (active.current === controller && current.current.documentIds.includes(id)) current.current.onOpen(id)
      } catch (reason) {
        const cancelled = signal.aborted || (reason instanceof DOMException && reason.name === 'AbortError')
        if (active.current === controller && (!cancelled || timedOut)) {
          setError(timedOut ? '阅读器加载超时，请重试。' : '阅读器加载失败，请重试。')
        }
      } finally {
        window.clearTimeout(timer)
        if (active.current === controller) {
          active.current = null
          scene.current?.cancelReaderEntry()
          setPhase(null)
        }
      }
    })()
  }, [scene])

  return { open, cancel, phase, error }
}
