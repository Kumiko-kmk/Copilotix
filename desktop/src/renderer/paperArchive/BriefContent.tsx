import { CONTRIBUTION_KIND_LABELS, FINDING_STRENGTH_LABELS, type PaperBrief } from '@shared/paperBrief/schema'
import type { BriefAnchor } from '@shared/paperBrief/contracts'
import ArchiveText from './ArchiveText'

export type BriefTab = 'overview' | 'findings' | 'limits'

export default function BriefContent(props: { brief: PaperBrief; anchors: BriefAnchor[]; tab: BriefTab }): React.JSX.Element {
  const { brief, anchors, tab } = props
  const analysis = brief.analysis
  if (analysis) return <div className="paper-archive-brief-content">
    {tab === 'overview' ? <p><ArchiveText text={analysis.background} /></p> : tab === 'findings' ? <ol>
      {analysis.conclusions.map((item, index) => <li key={item.title} className="paper-archive-finding">
        <h3><ArchiveText text={item.title} /></h3>
        <p><ArchiveText text={item.text} /></p>
        {!brief.checks[index]?.grounded || !brief.checks[index]?.numbersVerified ? <small className="paper-archive-brief-note">证据需核对</small> : null}
        <Sources ids={item.anchors} anchors={anchors} />
      </li>)}
    </ol> : <>
      <h3>领域贡献</h3><p><ArchiveText text={analysis.discussion.contribution} /></p>
      <h3>研究进展</h3><p><ArchiveText text={analysis.discussion.progress} /></p>
      <h3>局限与展望</h3><p><ArchiveText text={analysis.discussion.limitations} /></p>
    </>}
  </div>
  return <div className="paper-archive-brief-content">
    {tab === 'overview' ? <>
      <h3>背景</h3><p><ArchiveText text={brief.context.background} /></p>
      <h3>研究缺口</h3><p><ArchiveText text={brief.context.gap} /></p>
      <h3>研究问题</h3><p><ArchiveText text={brief.context.question} /></p>
    </> : tab === 'findings' ? <>
      <h3>核心方法</h3><p><ArchiveText text={brief.approach.summary} /></p><Items items={brief.approach.keyIdeas} />
      <p className="paper-archive-brief-note">结论强度由 AI 判断；摘录和数字匹配不等于结论已获验证。</p>
      {brief.findings.map((finding, index) => {
        const check = brief.checks[index]
        return <section key={finding.claim} className="paper-archive-finding">
          <h3><ArchiveText text={finding.claim} /></h3>
          <span className="paper-archive-badge">{FINDING_STRENGTH_LABELS[finding.strength]}</span>
          {!check?.grounded || !check.numbersVerified ? <span className="paper-archive-badge needs-review">需核对</span> : null}
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
