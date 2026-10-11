import React from 'react'
import { ArrowLeftOutlined, ArrowRightOutlined, MinusOutlined, PlusOutlined } from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import type { DocumentDetails } from '@shared/ipcSchemas'
import { ArchiveViewer, viewerParts, type ViewerSection, type ViewerState } from './archiveViewer'
import { drawSectionSheet } from './anatomySheets'
import { archiveTitle, extractPaperProfile } from './paperProfile'

/** Sections beyond this are folded into the last sheet so the layers stay readable. */
const MAX_SECTIONS = 8
const DEMO_SECTIONS = ['摘要', '引言', '方法', '实验', '结论']

/**
 * The 360° viewer around an extracted file, after RhineLabUI's model viewer: the file's name at the
 * top, its parts listed on the right, take apart / put together and the view reset below. The file
 * is taken apart by the paper's structure; section content is a demo for now
 * (docs/ARCHIVE_ANATOMY_ZH.md).
 */
export default function ArchiveAnatomy(props: {
  paperId: string
  displayName: string
  fileNumber: number
  category: string
  onClose(): void
}): React.JSX.Element {
  const details = useQuery<DocumentDetails>({ queryKey: ['document', props.paperId], queryFn: () => window.copilotix.getDocument(props.paperId) })
  const title = archiveTitle(props.displayName)
  const labels = React.useMemo(() => {
    if (!details.data) return null
    const sections = extractPaperProfile(details.data.markdown, details.data.translatedMarkdown).sections
    const found = sections.length ? sections : DEMO_SECTIONS
    return found.length > MAX_SECTIONS
      ? [...found.slice(0, MAX_SECTIONS - 1), `其余 ${found.length - MAX_SECTIONS + 1} 节`]
      : found
  }, [details.data])
  const rootRef = React.useRef<HTMLElement>(null)
  const hostRef = React.useRef<HTMLDivElement>(null)
  const viewerRef = React.useRef<ArchiveViewer | null>(null)
  const [apart, setApart] = React.useState(false)
  const [state, setState] = React.useState<ViewerState | 'loading' | 'failed'>('loading')
  const [selected, setSelected] = React.useState<string | null>(null)
  const closingRef = React.useRef(false)
  const reduced = React.useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches, [])

  React.useEffect(() => {
    const host = hostRef.current
    if (!host || !labels) return
    const sections: ViewerSection[] = labels.map((label, index) => ({ label, sheet: drawSectionSheet(index, labels.length, label, title) }))
    const background = getComputedStyle(host).getPropertyValue('--archive-bg').trim() || '#f7f2e8'
    const viewer = new ArchiveViewer(host, sections, { background, reduced, onState: setState })
    viewerRef.current = viewer
    let timer = 0
    viewer.load().then(() => {
      setState('assembled')
      viewer.focusCanvas()
      // Opened to be taken apart: it comes apart once, after the view has settled in.
      timer = window.setTimeout(() => { viewer.setExploded(true); setApart(true) }, reduced ? 0 : 420)
    }, () => setState('failed'))
    return () => {
      window.clearTimeout(timer)
      viewer.dispose()
      viewerRef.current = null
    }
  }, [labels, title, reduced])

  const close = React.useCallback(() => {
    const root = rootRef.current
    if (closingRef.current) return
    closingRef.current = true
    if (!root || reduced) { props.onClose(); return }
    const fade = root.animate([{ opacity: getComputedStyle(root).opacity }, { opacity: 0 }], { duration: 220, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' })
    void fade.finished.then(props.onClose, props.onClose)
  }, [props.onClose, reduced])

  const toggle = (next: boolean): void => {
    viewerRef.current?.setExploded(next)
    setApart(next)
  }
  const choose = (id: string): void => {
    const next = selected === id ? null : id
    setSelected(next)
    viewerRef.current?.focus(next)
  }

  // The original's keys: Esc returns, Home resets, +/− zoom, arrows pan.
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return
      const viewer = viewerRef.current
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        close()
        return
      }
      if (!viewer) return
      const pans: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }
      if (event.key === 'Home') viewer.resetView()
      else if (event.key === '+' || event.key === '=' || event.key === '-') viewer.zoom(event.key !== '-')
      else if (pans[event.key] && !(event.target instanceof HTMLButtonElement)) viewer.pan(...pans[event.key]!)
      else return
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [close])

  const parts = React.useMemo(() => viewerParts((labels ?? []).map((label) => ({ label }))), [labels])
  const status = state === 'loading' ? '正在载入模型' : state === 'failed' ? '模型载入失败' : state === 'moving' ? (apart ? '正在拆解' : '正在重组') : state === 'apart' ? '已拆解' : '已组装'
  return (
    <section ref={rootRef} className="paper-archive-viewer" role="dialog" aria-modal="true" aria-label={`${title} 档案模型`} data-exploded={apart}>
      <div ref={hostRef} className="paper-archive-viewer-stage" />
      <header className="paper-archive-viewer-head">
        <button type="button" className="paper-archive-viewer-back" onClick={close}>
          <ArrowLeftOutlined aria-hidden="true" /><span>返回档案</span><kbd>Esc</kbd>
        </button>
        <div>
          <span className="paper-archive-eyebrow">FILE NO.{String(props.fileNumber).padStart(3, '0')}<i>/</i>OBJECT STUDY</span>
          <h2>{title}</h2>
          <p>{props.category}</p>
        </div>
        <span className="paper-archive-viewer-index" aria-hidden="true">360<sup>°</sup></span>
      </header>

      <aside className="paper-archive-viewer-parts" aria-label="档案结构">
        <span className="paper-archive-eyebrow">ASSEMBLY<i>/</i>篇章结构</span>
        <ol>
          {parts.map((part, index) => (
            <li key={part.id}>
              <button type="button" aria-pressed={selected === part.id} disabled={part.kind !== 'section'} onClick={() => choose(part.id)}>
                <small>{String(index + 1).padStart(2, '0')}</small>
                <span><strong>{part.label}</strong><em>{part.en}</em></span>
              </button>
            </li>
          ))}
        </ol>
        {selected ? (
          <p key={selected} className="paper-archive-viewer-note">
            示例：这里将显示「{parts.find((part) => part.id === selected)?.label}」的章节摘要、要点与相关图片。
          </p>
        ) : null}
      </aside>

      <footer className="paper-archive-viewer-foot">
        <p className="paper-archive-viewer-hints">拖动旋转<i>/</i>↑ ↓ ← → 平移<i>/</i>滚轮缩放</p>
        <div className="paper-archive-viewer-actions" role="group" aria-label="拆解">
          <button type="button" aria-pressed={apart} disabled={state === 'loading' || state === 'failed'} onClick={() => toggle(true)}><PlusOutlined aria-hidden="true" />拆解档案</button>
          <button type="button" aria-pressed={!apart} disabled={state === 'loading' || state === 'failed'} onClick={() => toggle(false)}><MinusOutlined aria-hidden="true" />一键重组</button>
        </div>
        <button type="button" className="paper-archive-viewer-reset" onClick={() => viewerRef.current?.resetView()}>
          <span>复位视角</span><ArrowRightOutlined aria-hidden="true" />
        </button>
      </footer>
      <p className="paper-archive-viewer-state" aria-live="polite">{status}</p>
    </section>
  )
}
