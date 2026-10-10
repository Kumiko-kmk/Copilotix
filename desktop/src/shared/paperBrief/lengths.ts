/**
 * Length rules for the paper brief, sized to where each field is shown (detail header, tab
 * panel lists). One table feeds the prompt and the check of fresh model output, so the two cannot
 * drift apart. Lengths are in 字: a Han character or CJK punctuation counts 1, any other
 * non-space character counts 0.5 (an English word of six letters ≈ 3 字).
 *
 * Only new output is checked; stored briefs keep the looser limits of paperBriefContentSchema.
 */
import type { PaperBriefContent } from './schema'

type Range = readonly [min: number, max: number]

export const BRIEF_LENGTHS = {
  tldr: [40, 70], // detail subtitle, two lines
  discipline: [2, 12],
  area: [4, 24],
  background: [120, 220],
  gap: [80, 160],
  question: [40, 100],
  summary: [200, 360],
  keyIdea: [30, 80],
  basis: [20, 40], // detail header field, two lines
  evaluation: [20, 40], // detail header field, two lines
  claim: [15, 50],
  evidence: [50, 150],
  scope: [0, 60],
  contribution: [20, 70],
  limitation: [20, 80],
  assumption: [15, 60],
  openQuestion: [15, 60],
  term: [2, 20],
  definition: [20, 70],
  audience: [15, 50],
  prerequisite: [2, 20],
  focusReason: [10, 40],
  keyword: [2, 16],
  missing: [2, 30]
} as const satisfies Record<string, Range>

export const BRIEF_COUNTS = {
  keyIdeas: [3, 5],
  findings: [3, 6],
  contributions: [2, 4],
  limitations: [2, 5],
  assumptions: [1, 4],
  openQuestions: [1, 3],
  terms: [3, 6],
  prerequisites: [2, 4],
  focus: [2, 4],
  keywords: [4, 8]
} as const satisfies Record<string, Range>

/** Fresh output may miss a range by this much before a repair is requested. */
const TOLERANCE = { below: 0.75, above: 1.15 }
const MISSING = /^原文未说明/u

export function displayLength(text: string): number {
  let length = 0
  for (const char of text) {
    if (/\s/u.test(char)) continue
    length += /[\p{Script=Han}　-〿＀-￯]/u.test(char) ? 1 : 0.5
  }
  return Math.round(length)
}

/** "40–70 字", for the prompt. */
export const rangeText = (range: Range): string => range[0] ? `${range[0]}–${range[1]}字` : `≤${range[1]}字`

/**
 * Problems with the lengths and counts of fresh output, phrased as repair hints. "原文未说明" is
 * always accepted as short: the model must never pad or invent to reach a minimum.
 */
export function checkBriefLengths(content: PaperBriefContent): string[] {
  const problems: string[] = []
  const field = (path: string, value: string, [min, max]: Range): void => {
    const length = displayLength(value)
    if (length > max * TOLERANCE.above) problems.push(`${path}：${length} 字，超过 ${max} 字上限，请精简`)
    else if (min && length < min * TOLERANCE.below && !MISSING.test(value.trim())) problems.push(`${path}：${length} 字，少于 ${min} 字，请依据摘录补充具体内容（摘录确实没有时写“原文未说明”）`)
  }
  // Lists that depend on what the paper states (limitations, open questions…) only have a maximum.
  const count = (path: string, items: readonly unknown[], [min, max]: Range, soft = false): void => {
    if (!soft && items.length < min) problems.push(`${path}：${items.length} 项，至少 ${min} 项`)
    if (items.length > max) problems.push(`${path}：${items.length} 项，至多 ${max} 项`)
  }
  const L = BRIEF_LENGTHS
  const C = BRIEF_COUNTS
  field('tldr', content.tldr, L.tldr)
  field('field.discipline', content.field.discipline, L.discipline)
  field('field.area', content.field.area, L.area)
  field('context.background', content.context.background, L.background)
  field('context.gap', content.context.gap, L.gap)
  field('context.question', content.context.question, L.question)
  field('approach.summary', content.approach.summary, L.summary)
  field('approach.basis', content.approach.basis, L.basis)
  field('approach.evaluation', content.approach.evaluation, L.evaluation)
  count('approach.keyIdeas', content.approach.keyIdeas, C.keyIdeas)
  content.approach.keyIdeas.forEach((idea, index) => field(`approach.keyIdeas.${index}`, idea, L.keyIdea))
  count('findings', content.findings, C.findings)
  content.findings.forEach((finding, index) => {
    field(`findings.${index}.claim`, finding.claim, L.claim)
    field(`findings.${index}.evidence`, finding.evidence, L.evidence)
    field(`findings.${index}.scope`, finding.scope, L.scope)
  })
  count('contributions', content.contributions, C.contributions, true)
  content.contributions.forEach((item, index) => field(`contributions.${index}.text`, item.text, L.contribution))
  count('limitations', content.limitations, C.limitations, true)
  content.limitations.forEach((item, index) => field(`limitations.${index}.text`, item.text, L.limitation))
  count('assumptions', content.assumptions, C.assumptions, true)
  content.assumptions.forEach((item, index) => field(`assumptions.${index}`, item, L.assumption))
  count('openQuestions', content.openQuestions, C.openQuestions, true)
  content.openQuestions.forEach((item, index) => field(`openQuestions.${index}`, item, L.openQuestion))
  count('terms', content.terms, C.terms)
  content.terms.forEach((item, index) => {
    field(`terms.${index}.term`, item.term, L.term)
    field(`terms.${index}.definition`, item.definition, L.definition)
  })
  field('reading.audience', content.reading.audience, L.audience)
  count('reading.prerequisites', content.reading.prerequisites, C.prerequisites, true)
  content.reading.prerequisites.forEach((item, index) => field(`reading.prerequisites.${index}`, item, L.prerequisite))
  count('reading.focus', content.reading.focus, C.focus, true)
  content.reading.focus.forEach((item, index) => field(`reading.focus.${index}.reason`, item.reason, L.focusReason))
  count('keywords', content.keywords, C.keywords)
  content.keywords.forEach((item, index) => field(`keywords.${index}`, item, L.keyword))
  content.coverage.missing.forEach((item, index) => field(`coverage.missing.${index}`, item, L.missing))
  return problems
}
