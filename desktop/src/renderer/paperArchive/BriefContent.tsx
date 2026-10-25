import { CONTRIBUTION_KIND_LABELS, type PaperBrief, backgroundPoints } from '@features/insight/core'
import type { BriefAnchor } from '@features/insight/core'
import ArchiveText from './ArchiveText'

export type BriefTab = 'overview' | 'findings' | 'limits'

export default function BriefContent(props: { brief: PaperBrief; anchors: BriefAnchor[]; tab: BriefTab }): React.JSX.Element {
  const { brief, anchors, tab } = props
  const analysis = brief.analysis
  if (analysis) {
    const points: Array<{ title: string; text: string; anchors?: string[] }> = tab === 'overview' ? backgroundPoints(analysis.background)
      : tab === 'findings' ? analysis.conclusions
        : [
          { title: '领域贡献', text: analysis.discussion.contribution },
          { title: '研究进展', text: analysis.discussion.progress },
          { title: '局限与展望', text: analysis.discussion.limitations }
        ]
    return <div className="paper-archive-brief-content paper-archive-reading">
      <ol className="paper-archive-reading-points">
        {points.map((item, index) => <li key={`${tab}-${index}`}>
          <span className="paper-archive-point-index" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
          <div>
            <h3 data-annotation-block-key={`archive:${tab}:${index}:title`}><ArchiveText text={item.title || ['领域现状', '已有方法与不足', '研究切入点'][index] || '研究背景'} /></h3>
            <p data-annotation-block-key={`archive:${tab}:${index}:body`}><ArchiveText text={item.text} /></p>
            {item.anchors ? <Sources ids={item.anchors} anchors={anchors} /> : null}
          </div>
        </li>)}
      </ol>
    </div>
  }
  return <div className="paper-archive-brief-content">
    {tab === 'overview' ? <>
      <h3>背景</h3><p><ArchiveText text={brief.context.background} /></p>
      <h3>研究缺口</h3><p><ArchiveText text={brief.context.gap} /></p>
      <h3>研究问题</h3><p><ArchiveText text={brief.context.question} /></p>
    </> : tab === 'findings' ? <>
      <h3>核心方法</h3><p><ArchiveText text={brief.approach.summary} /></p><Items items={brief.approach.keyIdeas} />
      {brief.findings.map((finding) => {
        return <section key={finding.claim} className="paper-archive-finding">
          <h3><ArchiveText text={finding.claim} /></h3>
          <p><ArchiveText text={finding.evidence} /></p>{finding.scope ? <p>适用范围：<ArchiveText text={finding.scope} /></p> : null}
          {finding.anchors.map((id) => {
            const anchor = anchors.find((item) => item.id === id)
            return anchor ? <details key={id} className="paper-archive-anchor"><summary>{id} · <ArchiveText text={anchor.section} /></summary><p><ArchiveText text={anchor.text} /></p></details> : <small key={id}>{id} · 摘录不可用</small>
          })}
        </section>
      })}
    </> : <>
      <h3>领域贡献</h3><ul>{brief.contributions.map((item) => <li key={item.text}><span className="paper-archive-badge">{CONTRIBUTION_KIND_LABELS[item.kind]}</span> <ArchiveText text={item.text} /></li>)}</ul>
      <h3>研究进展</h3><p>旧版档案未生成此项，重新生成后可查看完整讨论。</p>
      <h3>局限</h3>{brief.limitations.length ? <ul>{brief.limitations.map((item) => <li key={item.text}><span className="paper-archive-badge">{item.source === 'author' ? '作者自述' : 'AI 推断'}</span> <ArchiveText text={item.text} /></li>)}</ul> : <p>摘录未提供。</p>}
      <h3>成立前提</h3><Items items={brief.assumptions} />
      <h3>开放问题</h3><Items items={brief.openQuestions} />
    </>}
  </div>
}

function Items({ items }: { items: string[] }): React.JSX.Element {
  return items.length ? <ul>{items.map((item) => <li key={item}><ArchiveText text={item} /></li>)}</ul> : <p>摘录未提供。</p>
}

function Sources({ ids, anchors }: { ids: string[]; anchors: BriefAnchor[] }): React.JSX.Element | null {
  return ids.length ? <details className="paper-archive-anchor"><summary>原文依据 · {ids.join('、')}</summary>{ids.map(id => {
    const anchor = anchors.find(item => item.id === id)
    return anchor ? <section key={id}><h4>{id} · <ArchiveText text={anchor.section} /></h4><p><ArchiveText text={anchor.text} /></p></section> : <small key={id}>{id} · 原文不可用</small>
  })}</details> : null
}
