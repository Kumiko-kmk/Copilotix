import React from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowDownOutlined, ArrowLeftOutlined, ArrowRightOutlined, ArrowUpOutlined, ExpandOutlined } from '@ant-design/icons'
import type { DocumentSummary } from '@shared/ipcSchemas'
import type { PaperInsightSource, PaperInsightState } from '@features/insight/contract/paperInsight'
import type { LibraryCategories } from '@shared/libraryCategories'
import { PaperArchiveScene, type ArchivePalette, type DetailPhase } from '../paperArchive/PaperArchiveScene'
import { useArchiveReaderEntry } from '../paperArchive/useArchiveReaderEntry'
import { loadReaderPage } from '../readerPageLoader'
import ArchiveText from '../paperArchive/ArchiveText'
import ArchiveDetail, { type ArchiveMorph } from '../paperArchive/ArchiveDetail'
import ArchiveProgressRing from '../paperArchive/ArchiveProgressRing'
import { useArchivePreparation } from '../paperArchive/useArchivePreparation'
import { archiveTitle, archiveTranslatedTitle, extractPaperProfile } from '@shared/paperProfile'
import { buildArchiveColumns, paperIndexAt, shelfAt, wrap, type ArchiveCell, type ArchivePaper } from '../paperArchive/archiveShelves'
import { workflowSummaryText } from '../documentStatus'
import WorkflowSteps from '../components/WorkflowSteps'
import { takeLibraryFocus } from '../paperArchive/libraryFocus'
import type { ArchivePreparationStep } from '../paperArchive/useArchivePreparation'
import '../paperArchive/paperArchive.css'

// Survives page switches so returning from the reader lands on the same paper.
let lastPaperId: string | null = null
const SEARCH_LIMIT = 40

type Selection = { cell: ArchiveCell; paper: ArchivePaper | null }

export default function LibraryPage(props: {
  documents: DocumentSummary[]
  onOpen(documentId: string): void
  onCreate(): void
  /** AI structured readings; the AI tab is hidden until App provides a source. */
  insights?: PaperInsightSource
  /** Content categories for the columns; without it the library is one "全部论文" category. */
  loadCategories?: () => Promise<LibraryCategories>
}): React.JSX.Element {
  const hostRef = React.useRef<HTMLDivElement>(null)
  const pageRef = React.useRef<HTMLElement>(null)
  const searchRef = React.useRef<HTMLInputElement>(null)
  const panelRef = React.useRef<HTMLElement>(null)
  /** The browse panel's box when extraction starts; the detail panel stretches out of it. */
  const morphFromRef = React.useRef<ArchiveMorph | null>(null)
  const sceneRef = React.useRef<PaperArchiveScene | null>(null)
  const onOpenRef = React.useRef(props.onOpen)
  const [selection, setSelection] = React.useState<Selection>({ cell: { lane: 0, row: 0 }, paper: null })
  const documentIds = React.useMemo(() => props.documents.map(document => document.id), [props.documents])
  const readerEntry = useArchiveReaderEntry(sceneRef, selection.paper?.id, documentIds, props.onOpen)
  onOpenRef.current = readerEntry.open
  const preparation = useArchivePreparation(selection.paper, props.insights)
  const accessRef = React.useRef({ id: selection.paper?.id, ready: preparation.ready })
  accessRef.current = { id: selection.paper?.id, ready: preparation.ready }
  const [unsupported, setUnsupported] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const [searchOpen, setSearchOpen] = React.useState(false)
  const categories = useLibraryCategories(props.documents, props.loadCategories, props.insights)
  const shelves = React.useMemo(() => buildArchiveColumns(props.documents, categories?.categories), [props.documents, categories])
  const categoryCount = React.useMemo(() => new Set(shelves.map((shelf) => shelf.category)).size, [shelves])
  const searchIndex = React.useMemo(() => shelves.flatMap((shelf) => shelf.papers.map((paper) => ({
    paper, category: shelf.category, text: `${paper.displayName}\n${paper.originalName}`.toLowerCase()
  }))), [shelves])
  const matches = React.useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/u).filter(Boolean)
    return searchIndex.filter((item) => terms.every((term) => item.text.includes(term)))
  }, [query, searchIndex])
  const restoredRef = React.useRef(false)
  const [phase, setPhase] = React.useState<DetailPhase>('closed')
  /** The glass has begun to clear: the panel's redaction follows it. */
  const [decryptReveal, setDecryptReveal] = React.useState(false)
  /**
   * The paper just returned to from the detail view: its browse panel fades in whole instead of
   * rolling its title again. It stays marked until another paper is selected; clearing it on a
   * timer turned the suspended animations back on and replayed them half a second later.
   */
  const [returningId, setReturningId] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (phase === 'open') void loadReaderPage().catch(() => { /* A deliberate open can retry. */ })
    else if (phase === 'closing' || phase === 'closed') readerEntry.cancel()
  }, [phase, readerEntry.cancel])
  React.useLayoutEffect(() => {
    if (readerEntry.phase) pageRef.current?.focus({ preventScroll: true })
  }, [readerEntry.phase])
  const fileNumbers = React.useMemo(() => new Map(shelves.flatMap((shelf) => shelf.papers).map((paper, index) => [paper.id, index + 1])), [shelves])
  const showPage = React.useCallback((page: HTMLCanvasElement | null) => sceneRef.current?.setDetailPage(page), [])
  const [stats, setStats] = React.useState<ReturnType<PaperArchiveScene['getStats']> | null>(null)
  const [statsOpen, setStatsOpen] = React.useState(false)

  React.useEffect(() => {
    if (!statsOpen) {
      setStats(null)
      return
    }
    const read = (): void => { if (sceneRef.current) setStats(sceneRef.current.getStats()) }
    read()
    const timer = window.setInterval(read, 500)
    return () => window.clearInterval(timer)
  }, [statsOpen])

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
          setReturningId((current) => (current === paper?.id ? current : null))
          setSelection({ cell, paper })
        },
        onActivate: (paper) => onOpenRef.current(paper.id),
        canOpenDetail: (paper) => accessRef.current.id === paper.id && accessRef.current.ready,
        onError: () => setUnsupported(true),
        onDetailFrame: (frame) => {
          const page = pageRef.current
          if (!page) return
          // The detail panel spans the extracted card's height (see .paper-archive-detail).
          page.style.setProperty('--archive-detail-top', `${frame.top}px`)
          page.style.setProperty('--archive-detail-height', `${frame.bottom - frame.top}px`)
        },
        onDecryptReveal: () => setDecryptReveal(true),
        onDetailPhase: (next) => {
          if (next === 'opening' || next === 'closed') setDecryptReveal(false)
          if (next === 'closed') setReturningId(lastPaperId)
          // Still mounted here: React re-renders after this callback.
          if (next === 'opening' || next === 'open') {
            const panel = panelRef.current?.getBoundingClientRect()
            // The titles glide from here into the detail header.
            const box = (selector: string): DOMRect | null => panelRef.current?.querySelector(selector)?.getBoundingClientRect() ?? null
            const heading = panelRef.current?.querySelector('.paper-archive-title')
            if (panel?.height) morphFromRef.current = { title: box('.paper-archive-title > span'), subtitle: box('.paper-archive-translated-title'), titleSize: heading ? Number.parseFloat(getComputedStyle(heading).fontSize) : 0 }
          }
          if (next !== 'closed') setSearchOpen(false)
          setPhase(next)
          const active = document.activeElement
          if ((next === 'opening' || next === 'closing') && active instanceof HTMLElement && pageRef.current?.contains(active) && !active.closest('.paper-archive-tools')) {
            pageRef.current.focus({ preventScroll: true })
          }
        }
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
    const restoreId = !restoredRef.current && shelves.length ? takeLibraryFocus() ?? lastPaperId : null
    scene.setShelves(shelves)
    if (!restoredRef.current && shelves.length) {
      restoredRef.current = true
      if (restoreId) scene.focusPaper(restoreId, { instant: true })
    }
  }, [shelves])

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const scene = sceneRef.current
      if (event.ctrlKey && event.shiftKey && !event.altKey && event.code === 'KeyF') {
        event.preventDefault()
        setStatsOpen((open) => !open)
        return
      }
      if (event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented || event.isComposing) return
      const target = event.target instanceof HTMLElement ? event.target : null
      if (readerEntry.phase) {
        if (event.key === 'Escape') {
          event.preventDefault()
          readerEntry.cancel()
          pageRef.current?.focus({ preventScroll: true })
        } else if (target && pageRef.current?.contains(target)) event.preventDefault()
        return
      }
      if (!target || !pageRef.current?.contains(target)) return
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return
      if (document.querySelector('.ant-modal-wrap')) return
      if (event.key === '/') {
        event.preventDefault()
        searchRef.current?.focus()
        return
      }
      if (event.key === 'Escape' && searchOpen) {
        event.preventDefault()
        setSearchOpen(false)
        pageRef.current?.focus({ preventScroll: true })
        return
      }
      if (!scene || target.closest('.paper-archive-tools')) return
      if (event.key === 'Escape' && scene.detailOpen) {
        event.preventDefault()
        scene.closeDetail()
        pageRef.current?.focus({ preventScroll: true })
        return
      }
      if (target.closest('.paper-archive-detail-layer')) return
      const moves: Record<string, ['lane' | 'row', number]> = {
        ArrowLeft: ['lane', -1], ArrowRight: ['lane', 1], ArrowUp: ['row', -1], ArrowDown: ['row', 1]
      }
      const move = moves[event.key]
      if (move) {
        event.preventDefault()
        scene.navigate(move[0], move[1])
      } else if (event.key === 'Enter' && !(target instanceof HTMLButtonElement)) {
        // First Enter extracts the paper (as ACCESS FILE does in the original); the next one opens it.
        event.preventDefault()
        if (event.repeat) return
        if (scene.detailReady) scene.activate()
        else if (accessRef.current.ready) scene.openDetail()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [searchOpen, readerEntry.phase, readerEntry.cancel])

  const navigate = React.useCallback((axis: 'lane' | 'row', direction: number) => sceneRef.current?.navigate(axis, direction), [])
  const shelf = shelfAt(shelves, selection.cell.lane)
  const paper = selection.paper
  const displayTitle = paper ? archiveTitle(paper.displayName) : ''
  const paperIndex = paperIndexAt(shelves, selection.cell)
  const shelfIndex = shelves.length ? wrap(selection.cell.lane, shelves.length) : 0
  const empty = shelves.length === 0
  const chooseResult = (result: ArchivePaper): void => {
    lastPaperId = result.id
    setSearchOpen(false)
    setQuery('')
    if (unsupported) readerEntry.open(result.id)
    else {
      sceneRef.current?.focusPaper(result.id)
      pageRef.current?.focus({ preventScroll: true })
    }
  }

  return (
    <section ref={pageRef} tabIndex={-1} className={`paper-archive-page${phase !== 'closed' ? ' detail-open' : ''}`} aria-label="文库" aria-busy={readerEntry.phase !== null} data-detail-phase={phase} data-reader-entry={readerEntry.phase ?? undefined}>
      <div ref={hostRef} className="paper-archive-stage" onPointerDown={() => pageRef.current?.focus({ preventScroll: true })} />
      <div className="paper-archive-veil" aria-hidden="true" />
      <div className="paper-archive-floor-veil" aria-hidden="true" />
      {readerEntry.error ? <p className="paper-archive-reader-error" role="alert">{readerEntry.error}</p> : null}
      {stats ? (
        <output className="paper-archive-stats" aria-label="文库渲染诊断">
          {stats.fps} fps · DPR {stats.pixelRatio} × {stats.resolutionScale} · {stats.drawn} 卡 · {(stats.triangles / 1e6).toFixed(2)}M 三角形<br />{stats.gpu}
        </output>
      ) : null}

      <header className="paper-archive-brand">
        <span className="paper-archive-eyebrow">PAPER ARCHIVE</span>
        <h1>文库</h1>
        <p>{empty ? '暂无论文' : `${props.documents.length} 篇论文 · ${categoryCount} 个分类 · ${shelves.length} 列`}</p>
      </header>

      {/* While a paper is extracted the index folds down into its rule and the rule retracts. */}
      <div className={`paper-archive-tools${phase !== 'closed' ? ' collapsed' : ''}`} inert={phase !== 'closed'} aria-hidden={phase !== 'closed' ? true : undefined}>
        <div className="paper-archive-search" role="search" aria-label="文库检索"
          onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setSearchOpen(false) }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              setSearchOpen(false)
              pageRef.current?.focus({ preventScroll: true })
            }
          }}>
          <label htmlFor="paper-archive-search" className="paper-archive-eyebrow">ARCHIVE INDEX</label>
          <div className="paper-archive-search-field">
            <input id="paper-archive-search" ref={searchRef} type="search" autoComplete="off"
              aria-label="搜索文库" placeholder="搜索标题或文件名" value={query}
              aria-controls={searchOpen ? 'paper-archive-results' : undefined}
              onFocus={() => setSearchOpen(true)}
              onChange={(event) => { setQuery(event.target.value); setSearchOpen(true) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.repeat && !event.nativeEvent.isComposing && searchOpen && matches[0]) {
                  event.preventDefault()
                  chooseResult(matches[0].paper)
                }
              }} />
            <kbd aria-hidden="true">/</kbd>
          </div>
          {searchOpen ? (
            <div id="paper-archive-results" className="paper-archive-results">
              <p role="status">{matches.length ? `${matches.length} 篇论文${matches.length > SEARCH_LIMIT ? ` · 显示前 ${SEARCH_LIMIT} 篇，请细化关键词` : ''}` : '没有匹配的论文'}</p>
              <ul aria-label="搜索结果">
                {matches.slice(0, SEARCH_LIMIT).map(({ paper: result, category }) => (
                  <li key={result.id}><button type="button" data-document-id={result.id} onClick={() => chooseResult(result)}>
                    <span>{result.displayName}</span>
                    <small>{category} · {workflowSummaryText(result.workflow)}{unsupported ? ' · 打开阅读' : ''}</small>
                  </button></li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>

      {unsupported ? (
        <div className="paper-archive-panel paper-archive-empty" role="status">
          <h2>当前环境无法显示三维文库</h2>
          <p>可以使用右上角搜索查找论文，选择搜索结果即可打开阅读。</p>
        </div>
      ) : empty ? (
        <div className="paper-archive-panel paper-archive-empty" role="status">
          <span className="paper-archive-path">LIBRARY / EMPTY</span>
          <h2>文库还是空的</h2>
          <p>解析第一篇论文后，它会作为档案出现在这里。</p>
          <button type="button" className="paper-archive-action" onClick={props.onCreate}>
            <span>去新解析</span><ArrowRightOutlined aria-hidden="true" />
          </button>
        </div>
      ) : paper && phase !== 'closed' ? (
        <div className={`paper-archive-detail-layer${phase === 'closing' ? ' closing' : ''}`} inert={phase === 'closing'} aria-hidden={phase === 'closing' ? true : undefined}>
          <ArchiveDetail key={paper.id} paper={paper} category={shelf?.category ?? ''} fileNumber={fileNumbers.get(paper.id) ?? paperIndex + 1}
            phase={phase} morphFrom={morphFromRef.current} textReveal={decryptReveal || phase === 'open'} onPage={showPage} onOpen={() => readerEntry.open(paper.id)}
            onClose={() => { readerEntry.cancel(); sceneRef.current?.closeDetail() }} insights={props.insights} openingReader={readerEntry.phase !== null} />
        </div>
      ) : paper ? (
        <article ref={panelRef} className={`paper-archive-panel${returningId === paper.id ? ' returning' : ''}`} data-document-id={paper.id} aria-live="polite">
          <span className="paper-archive-path">LIBRARY<i>/</i>{shelf?.category}</span>
          <h2 key={paper.id} className="paper-archive-title"><span><ArchiveText text={displayTitle} /></span></h2>
          <BrowseTranslatedTitle paper={paper} />
          <div className="paper-archive-rule"><i /><ArchiveStatusLabel paper={paper} waiting={preparation.waiting} />
            {/* A file card that failed will not finish on its own: no ring stuck short of 100%. */}
            {preparation.waiting === 'analysis-failed' ? null : <ArchiveProgressRing key={paper.id} documentId={paper.id} progress={preparation.progress} ready={preparation.ready} />}</div>
          <dl className="paper-archive-meta">
            <BrowsePaperNotes key={paper.id} paper={paper} source={props.insights} />
          </dl>
          <div className="paper-archive-actions">
            <button type="button" className="paper-archive-action" disabled={!preparation.ready} onClick={() => { if (preparation.ready) sceneRef.current?.openDetail() }}>
              <span>查看档案</span><ExpandOutlined aria-hidden="true" />
            </button>
            <button type="button" className="paper-archive-action" disabled={readerEntry.phase !== null} onClick={() => readerEntry.open(paper.id)}>
              <span>打开阅读</span><ArrowRightOutlined aria-hidden="true" />
            </button>
          </div>
        </article>
      ) : null}

      {!empty && !unsupported && phase === 'closed' ? (
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
            <button type="button" aria-label="上一列" onClick={() => navigate('lane', -1)}><ArrowLeftOutlined /></button>
            <div>
              <small>COLUMN {pad(shelfIndex + 1)} / {pad(shelves.length)}</small>
              <span key={shelf?.key}>{shelf?.label}</span>
            </div>
            <button type="button" aria-label="下一列" onClick={() => navigate('lane', 1)}><ArrowRightOutlined /></button>
          </div>
          <p className="paper-archive-hints">←→ 切换列<i>/</i>↑↓ 前后论文<i>/</i>滚轮、拖拽 浏览<i>/</i>Enter 查看档案</p>
        </footer>
      ) : null}
    </section>
  )
}

const RULER_TICKS = 9
/** File-card states of recently selected papers, so the browse panel never re-loads in view. */
const notesCache = new Map<string, PaperInsightState>()

/** Read keywords and the file card's summary together after selection settles. */
function BrowsePaperNotes({ paper, source }: { paper: ArchivePaper; source?: PaperInsightSource }): React.JSX.Element {
  const [settled, setSettled] = React.useState(false)
  // Coming back from the detail view remounts this panel: start from what was already read.
  const [state, setCachedState] = React.useState<PaperInsightState | null>(() => notesCache.get(paper.id) ?? null)
  const setState = React.useCallback((next: PaperInsightState) => {
    notesCache.delete(paper.id)
    notesCache.set(paper.id, next)
    if (notesCache.size > 64) notesCache.delete(notesCache.keys().next().value!)
    setCachedState(next)
  }, [paper.id])
  React.useEffect(() => {
    let current = true
    let updated = false
    const stop = source?.subscribe((id, next) => {
      if (current && id === paper.id) { updated = true; setState(next) }
    })
    const timer = window.setTimeout(() => {
      setSettled(true)
      source?.get(paper.id).then((next) => { if (current && !updated) setState(next) }, () => undefined)
    }, 180)
    return () => { current = false; window.clearTimeout(timer); stop?.() }
  }, [paper.id, source, setState])
  const details = useQuery({
    queryKey: ['document', paper.id], queryFn: () => window.copilotix.getDocument(paper.id),
    enabled: settled, staleTime: 30_000
  })
  const extracted = React.useMemo(() => details.data
    ? extractPaperProfile(details.data.markdown, details.data.translatedMarkdown).keywords : [], [details.data])
  const fromCard = state?.status === 'ready' ? ('brief' in state ? state.brief.keywords : state.insight.keywords) : []
  const keywords = (fromCard.length ? fromCard : extracted).map((word) => word.trim().replace(/\s+/gu, ' ')).filter(Boolean).join(' ')
  const summary = state?.status === 'ready' ? ('brief' in state ? state.brief.tldr : state.insight.summary) : ''
  return <>
    <div className="paper-archive-keywords"><dt>关键词</dt><SingleLineKeywords text={keywords} /></div>
    <div className="paper-archive-summary"><dt>总结</dt><dd key={summary} className="paper-archive-arrive">{summary || '暂无总结'}</dd></div>
  </>
}

/** Fit keywords on one readable line without a hover popup. */
function SingleLineKeywords({ text }: { text: string }): React.JSX.Element {
  const ref = React.useRef<HTMLElement>(null)
  React.useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    let measuredWidth = -1
    const fit = (): void => {
      if (element.clientWidth === measuredWidth) return
      measuredWidth = element.clientWidth
      element.style.fontSize = '13px'
      if (element.scrollWidth > element.clientWidth && element.clientWidth > 0) {
        element.style.fontSize = `${Math.max(11, 13 * element.clientWidth / element.scrollWidth)}px`
      }
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(element)
    return () => observer.disconnect()
  }, [text])
  return <dd ref={ref} key={text} className="paper-archive-arrive">{text || '—'}</dd>
}

/**
 * The library's content categories. Reloaded (debounced) when papers are added, removed or change
 * state, and when a file card finishes, since its field can rename a category. Keeps showing the
 * previous categories while the next ones load.
 */
function useLibraryCategories(documents: readonly DocumentSummary[], load: (() => Promise<LibraryCategories>) | undefined, insights: PaperInsightSource | undefined): LibraryCategories | null {
  const [categories, setCategories] = React.useState<LibraryCategories | null>(null)
  const [cardsChanged, setCardsChanged] = React.useState(0)
  const key = React.useMemo(() => documents.map((document) => `${document.id}:${document.workflow.status}`).sort().join('|'), [documents])
  React.useEffect(() => insights?.subscribe((_id, state) => { if (state.status === 'ready') setCardsChanged((value) => value + 1) }), [insights])
  React.useEffect(() => {
    if (!load) return
    let current = true
    const timer = window.setTimeout(() => {
      load().then((next) => { if (current) setCategories((previous) => previous?.revision === next.revision ? previous : next) }, () => undefined)
    }, 400)
    return () => { current = false; window.clearTimeout(timer) }
  }, [key, cardsChanged, load])
  return load ? categories : null
}

/** Read only the selected paper after navigation settles; share the detail query cache. */
function BrowseTranslatedTitle({ paper }: { paper: ArchivePaper }): React.JSX.Element {
  const [settledId, setSettledId] = React.useState<string | null>(null)
  React.useEffect(() => {
    const timer = window.setTimeout(() => setSettledId(paper.id), 180)
    return () => window.clearTimeout(timer)
  }, [paper.id])
  const details = useQuery({
    queryKey: ['document', paper.id],
    queryFn: () => window.copilotix.getDocument(paper.id),
    enabled: settledId === paper.id,
    staleTime: 30_000
  })
  const translatedTitle = React.useMemo(() => archiveTranslatedTitle(details.data?.translatedMarkdown, true), [details.data?.translatedMarkdown])
  return <p className="paper-archive-translated-title"><ArchiveText text={translatedTitle || '\u00a0'} /></p>
}

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
    tray: token('--archive-tray', '#806447'),
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

/**
 * Words for what the progress ring is waiting on; empty once the paper is ready, and while the file
 * card is generating (the ring alone shows that). Unkeyed: it shares the rule with the ring, which
 * is keyed by paper, and a second element with the same key left old papers' labels behind.
 */
function ArchiveStatusLabel(props: { paper: ArchivePaper; waiting: ArchivePreparationStep }): React.JSX.Element | null {
  if (props.waiting === null || props.waiting === 'analysis') return null
  return (
    <span className="paper-archive-status" data-waiting={props.waiting}>
      {props.waiting === 'workflow' ? <WorkflowSteps workflow={props.paper.workflow} />
        : <span role="status">{props.waiting === 'analysis-failed' ? '档案卡未生成' : '正在准备图片与封面'}</span>}
    </span>
  )
}
