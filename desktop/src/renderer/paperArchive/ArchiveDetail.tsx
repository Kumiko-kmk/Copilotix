import React from 'react'
import { ArrowLeftOutlined, ArrowRightOutlined } from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import type { DocumentDetails } from '@shared/ipcSchemas'
import type { PaperInsight, PaperInsightSource, PaperInsightState } from '@shared/paperInsight'
import type { ArchivePaper } from './archiveShelves'
import type { DetailPhase } from './PaperArchiveScene'
import { extractPaperProfile } from './paperProfile'

type Tab = 'abstract' | 'structure' | 'insight'

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
  const [pages, setPages] = React.useState<number | null>(null)
  const [tab, setTab] = React.useState<Tab>('abstract')
  const [original, setOriginal] = React.useState(false)
  const revealed = props.phase !== 'opening'

  React.useEffect(() => {
    setPages(null)
    setTab('abstract')
    setOriginal(false)
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
        setPages(page.pages)
      })
      .catch(() => { /* The card stays frosted without a page; the fields still load. */ })
    return () => { cancelled = true }
  }, [data, profile, paper.id, paper.originalName, paper.displayName, onPage])

  const title = profile?.title ?? paper.displayName
  const subtitle = profile?.translatedTitle && profile.translatedTitle !== title ? profile.translatedTitle : null
  const abstract = original ? profile?.abstract : profile?.translatedAbstract ?? profile?.abstract
  const counts = profile?.counts
  const tabs: Array<[Tab, string]> = [['abstract', '摘要'], ['structure', '结构'], ...(props.insights ? [['insight', 'AI 解读'] as [Tab, string]] : [])]

  return (
    <>
      <button type="button" className="paper-archive-detail-back" onClick={props.onClose}>
        <ArrowLeftOutlined aria-hidden="true" /><span>返回档案</span><kbd>Esc</kbd>
      </button>
      <article className={`paper-archive-detail${revealed ? ' revealed' : ''}`} aria-label="论文档案" aria-busy={!revealed || details.isPending}>
        <header>
          <span className="paper-archive-path">FILE NO.{String(props.fileNumber).padStart(3, '0')}<i>/</i>{props.month}</span>
          <h2 className="paper-archive-reveal" style={{ '--i': 0 } as React.CSSProperties} title={title}>{title}</h2>
          {subtitle ? <p className="paper-archive-detail-subtitle paper-archive-reveal" style={{ '--i': 1 } as React.CSSProperties}>{subtitle}</p> : null}
        </header>
        <div className="paper-archive-rule"><i /></div>
        {details.isError ? <p className="paper-archive-detail-error" role="alert">论文内容读取失败，可以直接打开阅读。</p> : null}
        <dl className="paper-archive-fields">
          <Field index={2} wide label="作者 / 单位" value={profile?.authors ?? (profile ? '未识别' : null)} />
          <Field index={3} label="页数" value={pages ? `${pages} 页` : !profile ? null : /\.(?:md|markdown)$/iu.test(paper.originalName.trim()) ? 'Markdown 原文' : '—'} />
          <Field index={4} label="章节" value={profile ? `${profile.sections.length} 节` : null} />
          <Field index={5} label="图 · 表 · 公式" value={counts ? `${counts.figures} · ${counts.tables} · ${counts.equations}` : null} />
          <Field index={6} label="参考文献" value={counts ? `${counts.references} 条` : null} />
          {profile?.keywords.length ? <Field index={7} wide label="关键词" value={profile.keywords.join(' · ')} /> : null}
        </dl>
        <div className="paper-archive-tabs" role="tablist" aria-label="档案内容">
          {tabs.map(([id, label], index) => (
            <button key={id} type="button" role="tab" id={`paper-archive-tab-${id}`} aria-selected={tab === id}
              aria-controls="paper-archive-tabpanel" onClick={() => setTab(id)}>
              <small>{String(index + 1).padStart(2, '0')}</small>{label}
            </button>
          ))}
        </div>
        <section id="paper-archive-tabpanel" role="tabpanel" aria-labelledby={`paper-archive-tab-${tab}`} className="paper-archive-tabpanel paper-archive-reveal" style={{ '--i': 8 } as React.CSSProperties}>
          {tab === 'abstract' ? (
            <>
              <div className="paper-archive-tabpanel-head">
                <span className="paper-archive-eyebrow">ABSTRACT / {original ? '原文' : '译文'}</span>
                {profile?.abstract && profile.translatedAbstract ? (
                  <button type="button" onClick={() => setOriginal((value) => !value)}>{original ? '看译文' : '看原文'}</button>
                ) : null}
              </div>
              <p className="paper-archive-abstract">{abstract ?? (profile ? '未找到摘要段落。' : '正在读取…')}</p>
            </>
          ) : tab === 'structure' ? (
            profile?.sections.length
              ? <ol className="paper-archive-outline">{profile.sections.map((section) => <li key={section}>{section}</li>)}</ol>
              : <p className="paper-archive-abstract">{profile ? '未识别到章节标题。' : '正在读取…'}</p>
          ) : props.insights ? <InsightPanel documentId={paper.id} source={props.insights} /> : null}
        </section>
        <footer className="paper-archive-detail-actions">
          <button type="button" className="paper-archive-primary" onClick={props.onOpen}>
            <span>打开阅读</span><ArrowRightOutlined aria-hidden="true" />
          </button>
        </footer>
      </article>
    </>
  )
}

function Field(props: { index: number; label: string; value: string | null; wide?: boolean }): React.JSX.Element {
  return (
    <div className={props.wide ? 'wide' : undefined}>
      <dt>{props.label}</dt>
      <dd className="paper-archive-reveal" style={{ '--i': props.index } as React.CSSProperties}>{props.value ?? ' '}</dd>
    </div>
  )
}

function InsightPanel(props: { documentId: string; source: PaperInsightSource }): React.JSX.Element {
  const [state, setState] = React.useState<PaperInsightState | null>(null)
  React.useEffect(() => {
    let cancelled = false
    setState(null)
    props.source.get(props.documentId).then((next) => { if (!cancelled) setState(next) }, (error: unknown) => {
      if (!cancelled) setState({ status: 'failed', error: error instanceof Error ? error.message : String(error) })
    })
    const stop = props.source.subscribe((documentId, next) => { if (documentId === props.documentId) setState(next) })
    return () => {
      cancelled = true
      stop()
    }
  }, [props.documentId, props.source])
  const generate = (): void => {
    setState({ status: 'generating' })
    props.source.generate(props.documentId).catch((error: unknown) => setState({ status: 'failed', error: error instanceof Error ? error.message : String(error) }))
  }
  if (!state) return <p className="paper-archive-abstract">正在读取…</p>
  if (state.status === 'ready') return <InsightView insight={state.insight} stale={state.stale} onRegenerate={generate} />
  if (state.status === 'generating') return <p className="paper-archive-abstract" role="status">AI 正在阅读这篇论文…</p>
  if (state.status === 'unavailable') return <p className="paper-archive-abstract">{state.reason}</p>
  return (
    <div className="paper-archive-insight-empty">
      <p className="paper-archive-abstract">{state.status === 'failed' ? `生成失败：${state.error}` : '还没有为这篇论文生成结构化解读。'}</p>
      <button type="button" onClick={generate}>{state.status === 'failed' ? '重试' : '生成 AI 解读'}</button>
    </div>
  )
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
