import { CONTRIBUTION_KIND_LABELS, FINDING_STRENGTH_LABELS, type PaperBrief } from '@shared/paperBrief/schema'
import type { BriefAnchor } from '@shared/paperBrief/contracts'

export type BriefTab = 'overview' | 'findings' | 'limits'

export default function BriefContent(props: { brief: PaperBrief; anchors: BriefAnchor[]; tab: BriefTab }): React.JSX.Element {
  const { brief, anchors, tab } = props
  return <div className="paper-archive-brief-content">
    {tab === 'overview' ? <>
      <h3>背景</h3><p>{brief.context.background}</p>
      <h3>研究缺口</h3><p>{brief.context.gap}</p>
      <h3>研究问题</h3><p>{brief.context.question}</p>
      <h3>方法与关键思路</h3><p>{brief.approach.summary}</p><Items items={brief.approach.keyIdeas} />
      <h3>贡献</h3><ul>{brief.contributions.map((item) => <li key={item.text}><span className="paper-archive-badge">{CONTRIBUTION_KIND_LABELS[item.kind]}</span> {item.text}</li>)}</ul>
    </> : tab === 'findings' ? <>
      <p className="paper-archive-brief-note">结论强度由 AI 判断；摘录和数字匹配不等于结论已获验证。</p>
      {brief.findings.map((finding, index) => {
        const check = brief.checks[index]
        return <section key={finding.claim} className="paper-archive-finding">
          <h3>{finding.claim}</h3>
          <span className="paper-archive-badge">{FINDING_STRENGTH_LABELS[finding.strength]}</span>
          {!check?.grounded || !check.numbersVerified ? <span className="paper-archive-badge needs-review">需核对</span> : null}
          <p>{finding.evidence}</p>{finding.scope ? <p>适用范围：{finding.scope}</p> : null}
          {finding.anchors.map((id) => {
            const anchor = anchors.find((item) => item.id === id)
            return anchor ? <details key={id} className="paper-archive-anchor"><summary>{id} · {anchor.section}</summary><p>{anchor.text}</p></details> : <small key={id}>{id} · 摘录不可用</small>
          })}
        </section>
      })}
    </> : <>
      <h3>局限</h3>{brief.limitations.length ? <ul>{brief.limitations.map((item) => <li key={item.text}><span className="paper-archive-badge">{item.source === 'author' ? '作者自述' : 'AI 推断'}</span> {item.text}</li>)}</ul> : <p>摘录未提供。</p>}
      <h3>成立前提</h3><Items items={brief.assumptions} />
      <h3>开放问题</h3><Items items={brief.openQuestions} />
    </>}
    <p className="paper-archive-brief-note">{brief.coverage.basis === 'partial' ? '依据部分摘录生成' : '依据提供的正文生成'}{brief.coverage.missing.length ? ` · 缺少：${brief.coverage.missing.join('、')}` : ''}</p>
  </div>
}

function Items({ items }: { items: string[] }): React.JSX.Element {
  return items.length ? <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul> : <p>摘录未提供。</p>
}
