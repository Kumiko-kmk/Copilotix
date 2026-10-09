import React from 'react'
import { ArrowLeftOutlined, ArrowRightOutlined } from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import type { DocumentDetails } from '@shared/ipcSchemas'
import type { PaperInsight, PaperInsightSource, PaperInsightState } from '@shared/paperInsight'
import type { ArchivePaper } from './archiveShelves'
import type { DetailPhase } from './PaperArchiveScene'
import { extractPaperProfile } from './paperProfile'
import { PAPER_TYPE_LABELS } from '@shared/paperBrief/schema'
import BriefContent, { type BriefTab } from './BriefContent'

type Tab = 'abstract' | 'structure' | 'insight' | BriefTab

/**
 * The extracted paper's file, after RhineLabUI's detail view: masked fields that clear as the
 * cover decrypts. Mounted only while a paper is extracted, so the archive itself never loads
 * document bodies.
 */
export default function ArchiveDetail(props: {
  paper: ArchivePaper
  month: string
  fileNumber: number
  phase: Exclude<DetailPhase, 'closed'>
  /** The browse panel's box when extraction started; the panel stretches from it to the card's height. */
  morphFrom?: DOMRect | null
  onPage(page: HTMLCanvasElement | null): void
  onOpen(): void
  onClose(): void
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
  const revealed = props.phase !== 'opening'
  const insight = usePaperInsight(paper.id, props.insights)
  const ready = insight.ready
  const briefState = ready && 'brief' in ready ? ready : null
  const brief = briefState?.brief
  const articleRef = React.useRef<HTMLElement>(null)
  const closing = props.phase === 'closing'
  const { morphFrom } = props

  // Reveal the content from the browse panel's bounds, without decorative frame rules.
  React.useLayoutEffect(() => {
    const article = articleRef.current
    if (!article || !morphFrom || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const animations = stretchPanel(article, morphFrom, closing)
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
      .then(({ drawTextPage, loadDetailPage, renderPdfFirstPage }) => loadDetailPage(key, () => pdf
        ? renderPdfFirstPage(data.pdfUrl)
        : Promise.resolve(drawTextPage(profile.title ?? paper.displayName, profile.translatedAbstract ?? profile.abstract))))
      .then((page) => {
        if (cancelled) return
        onPage(page.canvas)
      })
      .catch(() => { /* The card stays frosted without a page; the fields still load. */ })
    return () => { cancelled = true }
  }, [data, profile, paper.id, paper.originalName, paper.displayName, onPage])

  const title = profile?.title ?? paper.displayName
  const subtitle = profile?.translatedTitle && profile.translatedTitle !== title ? profile.translatedTitle : null
  const abstract = profile?.translatedAbstract
  const tabs: Array<[Tab, string]> = brief ? [['overview', '概览'], ['findings', '发现'], ['limits', '局限与前提'], ['reading', '阅读路线与术语']]
    : [['abstract', '摘要'], ['structure', '结构'], ...(props.insights ? [['insight', 'AI 解读'] as [Tab, string]] : [])]
  const activeTab = tabs.some(([id]) => id === tab) ? tab : tabs[0]![0]

  return (
    <>
      <button type="button" className="paper-archive-detail-back" onClick={props.onClose}>
        <ArrowLeftOutlined aria-hidden="true" /><span>返回档案</span><kbd>Esc</kbd>
      </button>
      <article ref={articleRef} className={`paper-archive-detail${revealed ? ' revealed' : ''}`} aria-label="论文档案" aria-busy={!revealed || details.isPending}>
        <header>
          <span className="paper-archive-path">FILE NO.{String(props.fileNumber).padStart(3, '0')}<i>/</i>{props.month}</span>
          <h2 className="paper-archive-reveal" style={{ '--i': 0 } as React.CSSProperties} title={title}>{title}</h2>
          {brief ? <><p className="paper-archive-detail-subtitle paper-archive-reveal" style={{ '--i': 1 } as React.CSSProperties}>{brief.tldr}</p><p className="paper-archive-brief-tags paper-archive-reveal" style={{ '--i': 1 } as React.CSSProperties}><span>{PAPER_TYPE_LABELS[brief.paperType]}</span><span>{brief.field.discipline} · {brief.field.area}</span></p></> : subtitle ? <p className="paper-archive-detail-subtitle paper-archive-reveal" style={{ '--i': 1 } as React.CSSProperties}>{subtitle}</p> : null}
        </header>
        <div className="paper-archive-rule"><i /></div>
        {details.isError ? <p className="paper-archive-detail-error" role="alert">论文内容读取失败，可以直接打开阅读。</p> : null}
        <dl className="paper-archive-fields">
          <Field index={2} wide label="作者 / 单位" value={profile?.authors ?? (profile ? '未识别' : null)} />
          {brief ? <>
            <Field index={3} half label="证据基础" value={brief.approach.basis} />
            <Field index={4} half label="检验方式" value={brief.approach.evaluation} />
            <Field index={5} wide label="关键词" value={brief.keywords.join(' · ')} />
          </> : <>
            {profile?.keywords.length ? <Field index={7} wide label="关键词" value={profile.keywords.join(' · ')} /> : null}
          </>}

        </dl>
        <div className="paper-archive-tabs" role="tablist" aria-label="档案内容">
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
              <small>{String(index + 1).padStart(2, '0')}</small>{label}
            </button>
          ))}
        </div>
        <section id="paper-archive-tabpanel" role="tabpanel" tabIndex={0} aria-labelledby={`paper-archive-tab-${activeTab}`} className="paper-archive-tabpanel paper-archive-reveal" style={{ '--i': 8 } as React.CSSProperties}>
          {briefState ? <BriefContent brief={briefState.brief} anchors={briefState.anchors} tab={activeTab as BriefTab} /> : activeTab === 'abstract' ? (
            <>
              <div className="paper-archive-tabpanel-head">
                <span className="paper-archive-eyebrow">ABSTRACT</span>
              </div>
              <p className="paper-archive-abstract paper-archive-translated-abstract">{abstract ?? (profile ? '暂无译文摘要。' : '正在读取…')}</p>
            </>
          ) : activeTab === 'structure' ? (
            profile?.sections.length
              ? <ol className="paper-archive-outline">{profile.sections.map((section) => <li key={section}>{section}</li>)}</ol>
              : <p className="paper-archive-abstract">{profile ? '未识别到章节标题。' : '正在读取…'}</p>
          ) : ready && 'insight' in ready ? <InsightView insight={ready.insight} stale={ready.stale} onRegenerate={insight.generate} /> : <p className="paper-archive-abstract">生成档案卡后可查看研究问题、证据、发现与阅读路线。</p>}
        </section>
        {props.insights && insight.state?.status !== 'unavailable' ? <div className="paper-archive-brief-status" role="status">
          {insight.state?.status === 'generating' ? <>AI 正在阅读这篇论文… <button type="button" onClick={() => { void props.insights?.cancel?.(paper.id).catch(() => undefined) }}>取消生成</button></>
            : <>
              {insight.state?.status === 'failed' ? insight.state.error
                : briefState ? `${briefState.brief.provenance.model.name} · ${briefState.stale ? '论文内容已更新' : briefState.promptOutdated ? '可用新版提示词重新生成' : 'AI 档案卡'}`
                  : ready ? '旧版解读可继续阅读，可升级为新版档案卡。' : '尚未生成 AI 档案卡。'}
              {insight.state ? <button type="button" onClick={insight.generate}>{ready ? '重新生成档案卡' : '生成 AI 档案卡'}</button> : null}
            </>}
        </div> : null}
        <footer className="paper-archive-detail-actions">
          <button type="button" className="paper-archive-primary" onClick={props.onOpen}>
            <span>打开阅读</span><ArrowRightOutlined aria-hidden="true" />
          </button>
        </footer>
      </article>
    </>
  )
}

const OPEN_TIMING: KeyframeAnimationOptions = { duration: 440, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'backwards' }
const CLOSE_TIMING: KeyframeAnimationOptions = { duration: 180, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' }

/** Reveal between the browse panel's box and the detail bounds using clip-path. */
function stretchPanel(article: HTMLElement, from: DOMRect, closing: boolean): Animation[] {
  const to = article.getBoundingClientRect()
  if (!to.width || !to.height) return []
  const top = Math.min(to.height, Math.max(0, from.top - to.top))
  const bottom = Math.min(to.height - top, Math.max(0, to.bottom - from.bottom))
  const left = Math.min(to.width, Math.max(0, from.left - to.left))
  const right = Math.min(to.width - left, Math.max(0, to.right - from.right))
  const full = 'inset(0px 0px 0px 0px)'
  const narrow = `inset(${top}px ${right}px ${bottom}px ${left}px)`
  const timing = closing ? CLOSE_TIMING : OPEN_TIMING
  return [
    article.animate(closing ? [{ clipPath: full }, { clipPath: narrow }] : [{ clipPath: narrow }, { clipPath: full }], timing)
  ]
}

/** Wide and short fields keep one line (the full text is in the tooltip); half-width fields keep two. */
function Field(props: { index: number; label: string; value: string | null; wide?: boolean; half?: boolean }): React.JSX.Element {
  return (
    <div className={props.wide ? 'wide' : props.half ? 'half' : undefined}>
      <dt>{props.label}</dt>
      <dd className="paper-archive-reveal" title={props.value ?? undefined} style={{ '--i': props.index } as React.CSSProperties}>{props.value ?? ' '}</dd>
    </div>
  )
}

function usePaperInsight(documentId: string, source?: PaperInsightSource) {
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

function InsightView(props: { insight: PaperInsight; stale: boolean; onRegenerate(): void }): React.JSX.Element {
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
      <small>{insight.model.name}{props.stale ? ' · 论文内容已更新，' : ' · '}<button type="button" onClick={props.onRegenerate}>重新生成</button></small>
    </div>
  )
}
