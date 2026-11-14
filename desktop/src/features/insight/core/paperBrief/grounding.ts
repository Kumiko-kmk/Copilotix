/**
 * Deterministic checks after the model answers. Nothing here calls a model.
 * - parseBriefResponse: tolerate code fences / prose around the JSON, then validate, and turn
 *   schema errors into concrete repair hints for the single retry.
 * - groundBrief: drop anchors that point at excerpts which were never sent, de-duplicate lists,
 *   and check that every number quoted as evidence actually occurs in the cited excerpts.
 *   Findings that fail are kept but flagged, so the UI can mark them "需核对".
 */
import { paperBriefContentSchema, paperBriefGenerationSchema, paperBriefSchema, PAPER_BRIEF_SCHEMA_VERSION, type FindingCheck, type PaperBrief, type PaperBriefContent } from './schema'
import type { BriefContext } from './context'
import { byteLength } from './context'
import { PAPER_BRIEF_PROMPT_VERSION } from './prompt'
import { checkBriefLengths } from './lengths'
import type { ZodIssue } from 'zod'
import { groundPaperMetadata } from './metadata'

export type ParsedBrief = { ok: true; content: PaperBriefContent } | { ok: false; problems: string[] }

function generatedContent({ analysis, ...metadata }: ReturnType<typeof paperBriefGenerationSchema.parse>): PaperBriefContent {
  return { ...metadata, analysis,
    // Retain v2 consumers without asking the model for duplicate, hidden fields.
    context: { background: '原文未说明', gap: '原文未说明', question: '原文未说明' },
    approach: { summary: '原文未说明', keyIdeas: analysis.conclusions.map(item => item.title), basis: '原文未说明', evaluation: '原文未说明' },
    findings: analysis.conclusions.map(item => ({ claim: item.title, evidence: item.text, strength: 'unclear', scope: '', anchors: item.anchors })),
    contributions: analysis.conclusions.map(item => ({ kind: 'other', text: item.title })),
    limitations: [], assumptions: [], openQuestions: [], terms: [],
    reading: { audience: '原文未说明', prerequisites: [], focus: [] }
  }
}

/** Diagnostic copy only: extra fields must still fail, but must not hide length errors. */
function knownFieldsForRepair(value: unknown, issues: ZodIssue[]): unknown {
  const copy = structuredClone(value)
  for (const issue of issues) {
    if (issue.code !== 'unrecognized_keys') continue
    let parent: unknown = copy
    for (const key of issue.path) {
      if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key)) { parent = null; break }
      parent = (parent as Record<PropertyKey, unknown>)[key]
    }
    if (parent && typeof parent === 'object') for (const key of issue.keys) delete (parent as Record<string, unknown>)[key]
  }
  return copy
}

/**
 * `lengths: true` also checks the word-count ranges of BRIEF_LENGTHS. The service asks for it on
 * the first legacy answer only. Fresh four-part responses always enforce their display budgets.
 */
export function parseBriefResponse(raw: string, options: { lengths?: boolean; requireAnalysis?: boolean } = {}): ParsedBrief {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return { ok: false, problems: ['输出中没有 JSON 对象'] }
  let value: unknown
  try {
    value = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return { ok: false, problems: ['JSON 语法错误（检查引号、逗号与括号）'] }
  }
  const fresh = paperBriefGenerationSchema.safeParse(value)
  if (fresh.success) {
    const content = generatedContent(fresh.data)
    const problems = checkBriefLengths(content)
    return problems.length ? { ok: false, problems: problems.slice(0, 12) } : { ok: true, content }
  }
  if (options.requireAnalysis) {
    const problems = fresh.error.issues.map(issue => `${issue.path.join('.') || '根对象'}：${issue.message}`)
    if (fresh.error.issues.some(issue => issue.code === 'unrecognized_keys')) {
      const known = paperBriefGenerationSchema.safeParse(knownFieldsForRepair(value, fresh.error.issues))
      if (known.success) problems.push(...checkBriefLengths(generatedContent(known.data)))
    }
    return { ok: false, problems: problems.slice(0, 12) }
  }
  const result = paperBriefContentSchema.safeParse(value)
  if (result.success) {
    const problems = options.lengths ? checkBriefLengths(result.data) : []
    return problems.length ? { ok: false, problems: problems.slice(0, 12) } : { ok: true, content: result.data }
  }
  return {
    ok: false,
    problems: result.error.issues.slice(0, 12).map((issue) => `${issue.path.join('.') || '根对象'}：${issue.message}`)
  }
}

/** Numbers as quoted in evidence: 28.4, 41.8%, 1,024, 3.5×, 10^6 → comparable tokens. */
export function extractNumbers(text: string): string[] {
  return [...new Set((text.match(/\d+(?:[.,]\d+)*/gu) ?? [])
    .map((number) => number.replace(/,(?=\d{3}\b)/gu, ''))
    // Years and single digits ("3 个数据集", "第 2 节") are too common to be meaningful checks.
    .filter((number) => number.length >= 2 || number.includes('.')))]
}

function containsNumber(haystack: string, number: string): boolean {
  const normalized = haystack.replace(/(\d),(?=\d{3}\b)/gu, '$1')
  return new RegExp(`(?<![\\d.])${number.replace(/\./gu, '\\.')}(?![\\d])`, 'u').test(normalized)
}

function dedupe<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const normalized = key(item).toLowerCase().replace(/[\s\p{P}]+/gu, '')
    if (!normalized || seen.has(normalized)) return false
    seen.add(normalized)
    return true
  })
}

export function groundBrief(content: PaperBriefContent, context: BriefContext): { content: PaperBriefContent; checks: FindingCheck[] } {
  const excerpts = new Map(context.excerpts.map((excerpt) => [excerpt.id, excerpt.text]))
  const allText = context.excerpts.map((excerpt) => excerpt.text).join('\n')
  const outline = new Set(context.outline)
  const findings = dedupe(content.findings, (finding) => finding.claim).map((finding) => ({
    ...finding,
    anchors: [...new Set(finding.anchors.filter((anchor) => excerpts.has(anchor)))]
  }))
  const checks = findings.map((finding): FindingCheck => {
    const cited = finding.anchors.map((anchor) => excerpts.get(anchor)!).join('\n')
    const numbers = extractNumbers(finding.evidence)
    return {
      grounded: finding.anchors.length > 0,
      // Prefer the cited excerpts; accept the whole digest when anchors point slightly off.
      numbersVerified: numbers.every((number) => containsNumber(cited, number) || containsNumber(allText, number))
    }
  })
  return {
    checks,
    content: {
      ...content,
      ...(content.metadata ? { metadata: groundPaperMetadata(content.metadata, context) } : {}),
      findings,
      ...(content.analysis ? { analysis: { ...content.analysis, conclusions: findings.map(finding => ({ title: finding.claim, text: finding.evidence, anchors: finding.anchors })) } } : {}),
      approach: { ...content.approach, keyIdeas: dedupe(content.approach.keyIdeas, (idea) => idea) },
      contributions: dedupe(content.contributions, (item) => item.text),
      limitations: dedupe(content.limitations, (item) => item.text),
      assumptions: dedupe(content.assumptions, (item) => item),
      openQuestions: dedupe(content.openQuestions, (item) => item),
      terms: dedupe(content.terms, (item) => item.term),
      keywords: dedupe(content.keywords, (item) => item),
      // Reading focus must name a real section, or the reader cannot jump to it.
      reading: { ...content.reading, focus: content.reading.focus.filter((item) => outline.has(item.section)) },
      // The digest knows better than the model whether it was complete.
      coverage: context.coverage.truncated || context.coverage.missingRoles.length
        ? { ...content.coverage, basis: 'partial' }
        : content.coverage
    }
  }
}

export interface BriefProvenanceInput {
  provider: 'qwen' | 'deepseek' | 'codex'
  model: string
  sourceRevision: string
  generatedAt?: string
}

/** Final record for storage: grounded content, checks and provenance, validated as a whole. */
export function assembleBrief(content: PaperBriefContent, context: BriefContext, provenance: BriefProvenanceInput): PaperBrief {
  const grounded = groundBrief(content, context)
  return paperBriefSchema.parse({
    ...grounded.content,
    schemaVersion: PAPER_BRIEF_SCHEMA_VERSION,
    checks: grounded.checks,
    provenance: {
      promptVersion: PAPER_BRIEF_PROMPT_VERSION,
      model: { provider: provenance.provider, name: provenance.model },
      generatedAt: provenance.generatedAt ?? new Date().toISOString(),
      sourceRevision: provenance.sourceRevision,
      language: context.language,
      sentBytes: context.coverage.sentBytes,
      sourceBytes: context.coverage.sourceBytes
    }
  })
}

/** Keep the repair request small: the previous answer is echoed back clipped. */
export function clipPreviousAnswer(raw: string, maxBytes = 8 * 1024): string {
  if (byteLength(raw) <= maxBytes) return raw
  return `${raw.slice(0, Math.floor(maxBytes / 3))}…`
}
