import React from 'react'
import { ArrowDownOutlined, ArrowLeftOutlined, ArrowRightOutlined, ArrowUpOutlined } from '@ant-design/icons'
import type { DocumentSummary } from '@shared/ipcSchemas'
import { PaperArchiveScene, type ArchivePalette } from '../paperArchive/PaperArchiveScene'
import { groupPapersByMonth, paperIndexAt, shelfAt, wrap, type ArchiveCell, type ArchivePaper } from '../paperArchive/archiveShelves'
import { documentTypeLabel, formatTaskCreatedAt, statusLabels } from './TasksPage'
import '../paperArchive/paperArchive.css'

// Survives page switches so returning from the reader lands on the same paper.
let lastPaperId: string | null = null

type Selection = { cell: ArchiveCell; paper: ArchivePaper | null }

export default function LibraryPage(props: {
  documents: DocumentSummary[]
  onOpen(documentId: string): void
  onCreate(): void
}): React.JSX.Element {
  const hostRef = React.useRef<HTMLDivElement>(null)
  const sceneRef = React.useRef<PaperArchiveScene | null>(null)
  const onOpenRef = React.useRef(props.onOpen)
  onOpenRef.current = props.onOpen
  const [selection, setSelection] = React.useState<Selection>({ cell: { lane: 0, row: 0 }, paper: null })
  const [unsupported, setUnsupported] = React.useState(false)
  const shelves = React.useMemo(() => groupPapersByMonth(props.documents), [props.documents])
  const restoredRef = React.useRef(false)

  React.useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    let scene: PaperArchiveScene
    try {
      scene = new PaperArchiveScene({
        container: host,
        palette: readPalette(host),
        reducedMotion: motionQuery.matches,
        onSelect: (cell, paper) => {
          if (paper) lastPaperId = paper.id
          setSelection({ cell, paper })
        },
        onActivate: (paper) => onOpenRef.current(paper.id),
        onError: () => setUnsupported(true)
      })
    } catch {
      setUnsupported(true)
      return
    }
    sceneRef.current = scene
    const onMotionChange = (): void => scene.setReducedMotion(motionQuery.matches)
    motionQuery.addEventListener('change', onMotionChange)
    return () => {
      motionQuery.removeEventListener('change', onMotionChange)
      sceneRef.current = null
      restoredRef.current = false
      scene.dispose()
    }
  }, [])

  React.useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    scene.setShelves(shelves)
    if (!restoredRef.current && shelves.length) {
      restoredRef.current = true
      if (lastPaperId) scene.focusPaper(lastPaperId, { instant: true })
    }
  }, [shelves])

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const scene = sceneRef.current
      if (!scene || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return
      const target = event.target as HTMLElement | null
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return
      if (document.querySelector('.ant-modal-wrap')) return
      const moves: Record<string, ['lane' | 'row', number]> = {
        ArrowLeft: ['lane', -1], ArrowRight: ['lane', 1], ArrowUp: ['row', -1], ArrowDown: ['row', 1]
      }
      const move = moves[event.key]
      if (move) {
        event.preventDefault()
        scene.navigate(move[0], move[1])
      } else if (event.key === 'Enter' && !(target instanceof HTMLButtonElement)) {
        event.preventDefault()
        scene.activate()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const navigate = React.useCallback((axis: 'lane' | 'row', direction: number) => sceneRef.current?.navigate(axis, direction), [])
  const shelf = shelfAt(shelves, selection.cell.lane)
  const paper = selection.paper
  const paperIndex = paperIndexAt(shelves, selection.cell)
  const shelfIndex = shelves.length ? wrap(selection.cell.lane, shelves.length) : 0
  const empty = shelves.length === 0

  return (
    <section className="paper-archive-page" aria-label="文库">
      <div ref={hostRef} className="paper-archive-stage" />
      <div className="paper-archive-veil" aria-hidden="true" />

      <header className="paper-archive-brand">
        <span className="paper-archive-eyebrow">PAPER ARCHIVE</span>
        <h1>文库</h1>
        <p>{empty ? '暂无论文' : `${props.documents.length} 篇论文 · ${shelves.length} 个月份`}</p>
      </header>

      {unsupported ? (
        <div className="paper-archive-panel paper-archive-empty" role="status">
          <h2>当前环境无法显示三维文库</h2>
          <p>显卡加速不可用，可以在任务管理中浏览全部论文。</p>
        </div>
      ) : empty ? (
        <div className="paper-archive-panel paper-archive-empty" role="status">
          <span className="paper-archive-path">LIBRARY / EMPTY</span>
          <h2>文库还是空的</h2>
          <p>解析第一篇论文后，它会作为档案出现在这里。</p>
          <button type="button" className="paper-archive-action" onClick={props.onCreate}>
            <span>去新解析</span><ArrowRightOutlined />
          </button>
        </div>
      ) : paper ? (
        <article className="paper-archive-panel" aria-live="polite">
          <span className="paper-archive-path">LIBRARY<i>/</i>{shelf?.label}</span>
          <h2 key={paper.id} className="paper-archive-title" title={paper.displayName}>{paper.displayName}</h2>
          <div className="paper-archive-rule"><i /></div>
          <dl className="paper-archive-meta">
            <div><dt>状态</dt><dd className={`status-${paper.workflow.status}`}>{statusLabels[paper.workflow.status]}{paper.workflow.status === 'translating' ? ` ${paper.workflow.progress}%` : ''}</dd></div>
            <div><dt>类型</dt><dd>{documentTypeLabel(paper.originalName)}</dd></div>
            <div><dt>创建</dt><dd>{formatTaskCreatedAt(paper.createdAt)}</dd></div>
          </dl>
          <button type="button" className="paper-archive-action" onClick={() => props.onOpen(paper.id)}>
            <span>打开阅读</span><ArrowRightOutlined />
          </button>
        </article>
      ) : null}

      {!empty && !unsupported ? (
        <footer className="paper-archive-footer">
          <div className="paper-archive-index" aria-label={`第 ${paperIndex + 1} 篇，共 ${shelf?.papers.length ?? 0} 篇`}>
            <span className="paper-archive-eyebrow">PAPER / SELECT</span>
            <div><strong key={paperIndex}>{pad(paperIndex + 1)}</strong><small>/ {pad(shelf?.papers.length ?? 0)}</small></div>
          </div>
          <div className="paper-archive-rows">
            <button type="button" aria-label="上一篇" onClick={() => navigate('row', -1)}><ArrowUpOutlined /></button>
            <Ruler count={shelf?.papers.length ?? 0} index={paperIndex} />
            <button type="button" aria-label="下一篇" onClick={() => navigate('row', 1)}><ArrowDownOutlined /></button>
          </div>
          <div className="paper-archive-shelves">
            <button type="button" aria-label="上一个月份" disabled={shelves.length < 2} onClick={() => navigate('lane', -1)}><ArrowLeftOutlined /></button>
            <div>
              <small>SHELF {pad(shelfIndex + 1)} / {pad(shelves.length)}</small>
              <span key={shelf?.key}>{shelf?.label}</span>
            </div>
            <button type="button" aria-label="下一个月份" disabled={shelves.length < 2} onClick={() => navigate('lane', 1)}><ArrowRightOutlined /></button>
          </div>
          <p className="paper-archive-hints">←→ 切换月份<i>/</i>↑↓ 前后论文<i>/</i>滚轮、拖拽 浏览<i>/</i>Enter 打开</p>
        </footer>
      ) : null}
    </section>
  )
}

const RULER_TICKS = 9

/** A fixed-width ruler; long shelves map onto it proportionally. */
function Ruler(props: { count: number; index: number }): React.JSX.Element {
  const ticks = Math.min(RULER_TICKS, Math.max(props.count, 1))
  const active = props.count <= RULER_TICKS
    ? props.index
    : Math.round((props.index / Math.max(1, props.count - 1)) * (ticks - 1))
  return (
    <div className="paper-archive-ruler" aria-hidden="true">
      {Array.from({ length: ticks }, (_, tick) => <i key={tick} className={tick === active ? 'active' : undefined} />)}
    </div>
  )
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function readPalette(element: HTMLElement): ArchivePalette {
  const style = getComputedStyle(element)
  const token = (name: string, fallback: string): string => style.getPropertyValue(name).trim() || fallback
  return {
    background: token('--archive-bg', '#f7f2e8'),
    floor: token('--archive-floor', '#dccdbb'),
    card: token('--archive-card', '#fff7ed'),
    cardSelected: token('--archive-card-selected', '#ffffff'),
    edge: token('--archive-edge', '#fff5e9'),
    accent: token('--archive-accent', '#5b58d6'),
    index: {
      done: token('--archive-index-done', '#e4d6c5'),
      active: token('--archive-index-active', '#5b58d6'),
      partial: token('--archive-index-partial', '#d39b35'),
      failed: token('--archive-index-failed', '#cf5049'),
      empty: token('--archive-index-empty', '#e4d6c5')
    }
  }
}
