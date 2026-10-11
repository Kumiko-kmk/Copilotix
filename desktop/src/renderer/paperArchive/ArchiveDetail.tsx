import React from 'react'
import { ArrowLeftOutlined, ArrowRightOutlined, BlockOutlined } from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import type { DocumentDetails } from '@shared/ipcSchemas'
import type { PaperInsight, PaperInsightSource } from '@shared/paperInsight'
import { usePaperInsight } from '../usePaperInsight'
import type { ArchivePaper } from './archiveShelves'
import type { DetailPhase } from './PaperArchiveScene'
import { archiveTitle, archiveTranslatedTitle, extractPaperProfile } from './paperProfile'
import BriefContent, { type BriefTab } from './BriefContent'
import { useLineRedaction } from './lineRedaction'
import { composeSpread, drawFigureSheet, loadSpreadCandidates, loadSpreadImages } from './figureSpread'
import type { DetailPage } from './detailPage'

type Tab = 'abstract' | 'structure' | 'insight' | BriefTab

/**
 * The extracted paper's file, after RhineLabUI's detail view: every line is redacted until the
 * glass clears, then the ink slides away line by line. Mounted only while a paper is extracted, so the archive itself never loads
 * document bodies.
 */
export default function ArchiveDetail(props: {
  paper: ArchivePaper
  /** Content category of the paper (shared/libraryCategories.ts). */
  category: string
  fileNumber: number
  phase: Exclude<DetailPhase, 'closed'>
  /** Where the browse panel's titles were when extraction started; the detail titles glide from there. */
  morphFrom?: ArchiveMorph | null
  /** The glass has started to clear (or the file is already open): lift the redaction. */
  textReveal?: boolean
  onPage(page: HTMLCanvasElement | null): void
  onOpen(): void
  onClose(): void
  /** Take the file apart in the 360° viewer (ArchiveAnatomy.tsx). */
  onInspect?(): void
  insights?: PaperInsightSource
}): React.JSX.Element {
  const { paper, onPage } = props
  const details = useQuery<DocumentDetails>({
    queryKey: ['document', paper.id],
    queryFn: () => window.copilotix.getDocument(paper.id)
  })
  const profile = React.useMemo(
    () => details.data ? extractPaperProfile(details.data.markdown, details.data.translatedMarkdown) : null,
    [details.data]
  )
  const [tab, setTab] = React.useState<Tab>('abstract')
  const revealed = props.textReveal ?? props.phase === 'open'
  const insight = usePaperInsight(paper.id, props.insights)
  const ready = insight.ready
  const briefState = ready && 'brief' in ready ? ready : null
  const brief = briefState?.brief
  const articleRef = React.useRef<HTMLElement>(null)
  const redactionRef = React.useRef<HTMLDivElement>(null)
  const redactedContent = React.useMemo(() => ({}), [details.data, ready, tab])
  // The text is lifted only once it has loaded: lifting earlier left bars over the old layout
  // (covering the tab labels) while late text appeared below them uncovered.
  const contentLoaded = !details.isPending && (!props.insights || insight.state !== null)
  useLineRedaction(articleRef, redactionRef, { covered: props.phase !== 'closing', reveal: revealed && contentLoaded, content: redactedContent })
  const closing = props.phase === 'closing'
  const { morphFrom } = props

  // In order: the titles glide up from the browse panel into the header first, and only then does
  // the file unfold beneath them, so a rising title never passes through the redaction bars.
  // Closing reverses it: the file fades first while the titles glide back down.
  const reopenedRef = React.useRef(false)
  React.useLayoutEffect(() => {
    const article = articleRef.current
    if (!article || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    if (closing) reopenedRef.current = true
    // Reopened while closing: the titles are still in place, so the file simply fades back in.
    const glides = morphFrom && !(reopenedRef.current && !closing)
    const body = [...article.children].filter((child): child is HTMLElement => child instanceof HTMLElement && child.tagName !== 'HEADER')
    const animations = [
      ...body.map((element) => element.animate(
        closing ? [{ opacity: 1 }, { opacity: 0 }] : [{ opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'none' }],
        closing ? BODY_CLOSE : { ...BODY_OPEN, delay: glides ? BODY_OPEN.delay : 0 }
      )),
      ...(glides && morphFrom ? [
        ...glide(article.querySelector('header h2'), morphFrom.title, morphFrom.titleSize, closing),
        ...glide(article.querySelector('header .paper-archive-translated-title'), morphFrom.subtitle, 0, closing)
      ] : [])
    ]
    return () => animations.forEach((animation) => animation.cancel())
  }, [closing, morphFrom])

  React.useEffect(() => {
    setTab('abstract')
    onPage(null)
  }, [paper.id, onPage])

  const data = details.data
  React.useEffect(() => {
    if (!data || !profile) return
    let cancelled = false
    const pdf = !/\.(?:md|markdown)$/iu.test(paper.originalName.trim())
    const key = `${paper.id}:${data.summary.updatedAt}`
    // pdf.js is loaded only when a paper is extracted.
    import('./detailPage')
      .then(({ drawTextPage, loadDetailPage, renderPdfFirstPage }) => loadDetailPage(`${key}:spread`, () => pdf
        ? renderSpread(paper.id, data.pdfUrl, data.assetBaseUrl, renderPdfFirstPage)
        : Promise.resolve(drawTextPage(profile.title ?? paper.displayName, profile.translatedAbstract ?? profile.abstract))))
      .then((page) => {
        if (cancelled) return
        onPage(page.figures ? composeSpread(page.canvas, page.figures.sheet) : page.canvas)
      })
      .catch(() => { /* The card stays frosted without a page; the fields still load. */ })
    return () => { cancelled = true }
  }, [data, profile, paper.id, paper.originalName, paper.displayName, onPage])

  const title = archiveTitle(paper.displayName)
  const subtitle = React.useMemo(() => archiveTranslatedTitle(details.data?.translatedMarkdown), [details.data?.translatedMarkdown])
  const abstract = profile?.translatedAbstract
  // The count beside a tab says how much is behind it before switching.
  const tabs: Array<[Tab, string, number?]> = brief
    ? [['abstract', '摘要'], ['overview', '概览'], ['findings', '发现', brief.findings.length], ['limits', '局限与前提', brief.limitations.length + brief.assumptions.length]]
    : [['abstract', '摘要'], ['structure', '结构', profile?.sections.length || undefined], ...(props.insights ? [['insight', 'AI 解读'] as [Tab, string]] : [])]
  const activeTab = tabs.some(([id]) => id === tab) ? tab : tabs[0]![0]
  const tabsRef = React.useRef<HTMLDivElement>(null)
  // One underline slides to the selected tab. It is placed without motion first, then moves.
  React.useLayoutEffect(() => {
    const list = tabsRef.current
    const active = list?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
    if (!list || !active) return
    list.style.setProperty('--tab-x', `${active.offsetLeft}px`)
    list.style.setProperty('--tab-w', `${active.offsetWidth}px`)
    if (list.dataset.indicator !== 'moving') {
      list.dataset.indicator = 'placed'
      const frame = requestAnimationFrame(() => { list.dataset.indicator = 'moving' })
      return () => cancelAnimationFrame(frame)
    }
  }, [activeTab, tabs.length, brief])

  return (
    <>
      <button type="button" className="paper-archive-detail-back" onClick={props.onClose}>
        <ArrowLeftOutlined aria-hidden="true" /><span>返回档案</span><kbd>Esc</kbd>
      </button>
      <article ref={articleRef} className="paper-archive-detail" aria-label="论文档案" aria-busy={!revealed || details.isPending}>
        <div ref={redactionRef} className="paper-archive-redactions" aria-hidden="true" />
        <header>
          <span className="paper-archive-path">FILE NO.{String(props.fileNumber).padStart(3, '0')}<i>/</i>{props.category}</span>
          {/* Not redacted: the titles were already readable in the browse panel and glide up from it. */}
          <h2>{title}</h2>
          <p className="paper-archive-translated-title">{subtitle || '\u00a0'}</p>
        </header>
        <div className="paper-archive-rule"><i /></div>
        {details.isError ? <p className="paper-archive-detail-error" role="alert">论文内容读取失败，可以直接打开阅读。</p> : null}
        <dl className="paper-archive-fields">
          <Field index={2} wide label="作者 / 单位" value={profile?.authors ?? (profile ? '未识别' : null)} />
          {brief ? <>
            <Field index={3} half label="证据基础" value={brief.approach.basis} />
            <Field index={4} half label="检验方式" value={brief.approach.evaluation} />
          </> : null}

        </dl>
        <div ref={tabsRef} className="paper-archive-tabs" role="tablist" aria-label="档案内容">
          {tabs.map(([id, label], index) => (
            <button key={id} type="button" role="tab" id={`paper-archive-tab-${id}`} aria-selected={activeTab === id}
              tabIndex={activeTab === id ? 0 : -1} aria-controls="paper-archive-tabpanel" onClick={() => setTab(id)}
              onKeyDown={(event) => {
                if (event.altKey || event.ctrlKey || event.metaKey) return
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
                  : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
                    : event.key === 'ArrowRight' ? (index + 1) % tabs.length : null
                if (next === null) return
                const nextTab = tabs[next]
                if (!nextTab) return
                event.preventDefault()
                setTab(nextTab[0])
                event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
              }}>
              <small>{String(index + 1).padStart(2, '0')}</small>{label}{tabs[index]![2] ? <span className="paper-archive-tab-count">{tabs[index]![2]}</span> : null}
            </button>
          ))}
        </div>
        <section id="paper-archive-tabpanel" role="tabpanel" tabIndex={0} aria-labelledby={`paper-archive-tab-${activeTab}`} className="paper-archive-tabpanel paper-archive-reveal" style={{ '--i': 8 } as React.CSSProperties}>
          {activeTab === 'abstract' ? (
            <>
              <div className="paper-archive-tabpanel-head">
                <span className="paper-archive-eyebrow" data-archive-unredacted>ABSTRACT</span>
              </div>
              <p className="paper-archive-abstract paper-archive-translated-abstract">{abstract ?? (profile ? '暂无译文摘要。' : '正在读取…')}</p>
            </>
          ) : briefState ? <BriefContent brief={briefState.brief} anchors={briefState.anchors} tab={activeTab as BriefTab} /> : activeTab === 'structure' ? (
            profile?.sections.length
              ? <ol className="paper-archive-outline">{profile.sections.map((section) => <li key={section}>{section}</li>)}</ol>
              : <p className="paper-archive-abstract">{profile ? '未识别到章节标题。' : '正在读取…'}</p>
          ) : ready && 'insight' in ready ? <InsightView insight={ready.insight} stale={ready.stale} /> : <p className="paper-archive-abstract">在阅读器中生成档案卡后，可在这里查看研究问题、证据、发现与局限。</p>}
        </section>
        <footer className="paper-archive-detail-actions">
          <button type="button" className="paper-archive-primary" onClick={props.onOpen}>
            <span>打开阅读</span><span className="paper-archive-primary-end"><kbd aria-hidden="true">Enter</kbd><ArrowRightOutlined aria-hidden="true" /></span>
          </button>
          {props.onInspect ? (
            <button type="button" className="paper-archive-action" disabled={props.phase !== 'open'} onClick={props.onInspect}>
              <span>拆解档案</span><BlockOutlined aria-hidden="true" />
            </button>
          ) : null}
        </footer>
      </article>
    </>
  )
}

/**
 * The card's face: the first page on the left and the key figures on a sheet of the same size on
 * the right. The figure list loads while the page renders; without usable figures the card keeps
 * the plain first page.
 */
async function renderSpread(documentId: string, pdfUrl: string, assetBaseUrl: string, renderPage: (url: string) => Promise<DetailPage>): Promise<DetailPage> {
  const candidates = loadSpreadCandidates(documentId, assetBaseUrl).catch(() => [])
  const page = await renderPage(pdfUrl)
  const ranked = await candidates
  if (!ranked.length) return page
  const { width, height } = page.canvas
  const figures = await loadSpreadImages(ranked, assetBaseUrl, { width, height }).catch(() => [])
  return figures.length ? { ...page, figures: { sheet: drawFigureSheet(width, height, figures) } } : page
}

export interface ArchiveMorph {
  title: DOMRect | null
  subtitle: DOMRect | null
  /** Font size of the browse title, so the detail title starts at that size. */
  titleSize: number
}

// The titles start after the search has mostly folded away (it needs 0.24 s), so a long title never
// meets it at the top of the page; the file below unfolds as they settle.
const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)'
const GLIDE_TIMING: KeyframeAnimationOptions = { duration: 440, delay: 120, easing: EASE_OUT, fill: 'backwards' }
const BODY_OPEN = { duration: 300, delay: 460, easing: EASE_OUT, fill: 'backwards' } satisfies KeyframeAnimationOptions
const BODY_CLOSE: KeyframeAnimationOptions = { duration: 120, easing: 'ease-out', fill: 'forwards' }
const CLOSE_TIMING: KeyframeAnimationOptions = { duration: 180, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' }

/** Move a header title from its place in the browse panel (scaled to that size) and back on close. */
function glide(element: Element | null, from: DOMRect | null, fromSize: number, closing: boolean): Animation[] {
  if (!(element instanceof HTMLElement) || !from?.height) return []
  const to = element.getBoundingClientRect()
  if (!to.height) return []
  const size = Number.parseFloat(getComputedStyle(element).fontSize)
  const scale = fromSize > 0 && size > 0 ? fromSize / size : 1
  const away = `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${scale})`
  element.style.transformOrigin = '0 0'
  const frames: Keyframe[] = closing ? [{ transform: 'none' }, { transform: away }] : [{ transform: away }, { transform: 'none' }]
  return [element.animate(frames, closing ? CLOSE_TIMING : GLIDE_TIMING)]
}

/** Wide and short fields keep one line; half-width fields keep two. */
function Field(props: { index: number; label: string; value: string | null; wide?: boolean; half?: boolean }): React.JSX.Element {
  return (
    <div className={props.wide ? 'wide' : props.half ? 'half' : undefined}>
      <dt>{props.label}</dt>
      <dd className="paper-archive-reveal" style={{ '--i': props.index } as React.CSSProperties}>{props.value ?? ' '}</dd>
    </div>
  )
}

function InsightView(props: { insight: PaperInsight; stale: boolean }): React.JSX.Element {
  const { insight } = props
  const list = (label: string, items: string[]): React.ReactNode => items.length ? (
    <div><dt>{label}</dt><dd><ul>{items.map((item) => <li key={item}>{item}</li>)}</ul></dd></div>
  ) : null
  return (
    <div className="paper-archive-insight">
      <p className="paper-archive-abstract">{insight.summary}</p>
      <dl>
        <div><dt>研究问题</dt><dd>{insight.researchQuestion}</dd></div>
        <div><dt>方法</dt><dd>{insight.method}</dd></div>
        {list('贡献', insight.contributions)}
        {list('主要发现', insight.findings)}
        {list('局限', insight.limitations)}
      </dl>
      <small>{insight.model.name}{props.stale ? ' · 论文内容已更新' : ''}</small>
    </div>
  )
}
