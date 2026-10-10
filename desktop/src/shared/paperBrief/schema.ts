/**
 * Paper brief v2: a field-independent structured reading of one paper.
 *
 * The shape follows established reading frameworks so it works for any discipline:
 * - Keshav, "How to Read a Paper" (five Cs): category → `paperType`, context → `context`,
 *   correctness → `assumptions` / finding `strength`, contributions → `contributions`.
 * - Swales' CARS model for the problem statement: background → gap → question.
 * - Structured abstracts / IMRaD for approach, evidence basis and evaluation.
 * - Toulmin's argument model for findings: claim + evidence + qualifier (strength) + scope.
 * Every finding cites excerpt ids (E1…), so a reader can check it against the paper.
 * Design notes: docs/PAPER_BRIEF_ZH.md.
 */
import { z } from 'zod'

export const PAPER_BRIEF_SCHEMA_VERSION = 2

export const PAPER_TYPES = ['empirical', 'method', 'theoretical', 'system', 'resource', 'review', 'position', 'case_study', 'qualitative', 'other'] as const
export const PAPER_TYPE_LABELS: Record<typeof PAPER_TYPES[number], string> = {
  empirical: '实证研究', method: '方法研究', theoretical: '理论研究', system: '系统与工程', resource: '数据集与基准',
  review: '综述', position: '观点与展望', case_study: '案例研究', qualitative: '质性研究', other: '其他'
}
export const FINDING_STRENGTHS = ['strong', 'moderate', 'limited', 'unclear'] as const
export const FINDING_STRENGTH_LABELS: Record<typeof FINDING_STRENGTHS[number], string> = {
  strong: '证据充分', moderate: '证据一般', limited: '证据有限', unclear: '无法判断'
}
export const CONTRIBUTION_KINDS = ['method', 'theory', 'empirical', 'resource', 'tool', 'synthesis', 'application', 'other'] as const
export const CONTRIBUTION_KIND_LABELS: Record<typeof CONTRIBUTION_KINDS[number], string> = {
  method: '新方法', theory: '新理论', empirical: '新发现', resource: '数据与基准', tool: '工具与系统',
  synthesis: '综述与整合', application: '应用', other: '其他'
}

const NO_CONTROL = (value: string): boolean => ![...value].some((char) => char.charCodeAt(0) < 32 && !'\t\n\r'.includes(char))
const text = (max: number) => z.string().trim().min(1).max(max).refine(NO_CONTROL, '不能包含控制字符')
const anchors = z.array(z.string().regex(/^E\d{1,3}$/u)).max(4)

/**
 * What the model writes. These are the storage limits in characters; they only ever grow, so
 * briefs saved under an older prompt stay valid. The display ranges for new output are in
 * lengths.ts.
 */
export const paperBriefContentSchema = z.object({
  paperType: z.enum(PAPER_TYPES),
  field: z.object({ discipline: text(40), area: text(60) }).strict(),
  tldr: text(120),
  context: z.object({ background: text(300), gap: text(300), question: text(300) }).strict(),
  approach: z.object({
    summary: text(420),
    keyIdeas: z.array(text(120)).min(1).max(5),
    basis: text(300),
    evaluation: text(300)
  }).strict(),
  findings: z.array(z.object({
    claim: text(160),
    evidence: text(240),
    strength: z.enum(FINDING_STRENGTHS),
    scope: z.string().trim().max(160).refine(NO_CONTROL),
    anchors
  }).strict()).min(1).max(6),
  contributions: z.array(z.object({ kind: z.enum(CONTRIBUTION_KINDS), text: text(160) }).strict()).min(1).max(5),
  limitations: z.array(z.object({ text: text(160), source: z.enum(['author', 'inferred']) }).strict()).max(5),
  assumptions: z.array(text(160)).max(4),
  openQuestions: z.array(text(160)).max(3),
  terms: z.array(z.object({ term: text(60), definition: text(160) }).strict()).max(6),
  reading: z.object({
    audience: text(120),
    prerequisites: z.array(text(60)).max(4),
    focus: z.array(z.object({ section: text(120), reason: text(80) }).strict()).max(4)
  }).strict(),
  keywords: z.array(text(40)).min(1).max(8),
  coverage: z.object({ basis: z.enum(['full', 'partial']), missing: z.array(text(80)).max(5) }).strict()
}).strict()
export type PaperBriefContent = z.infer<typeof paperBriefContentSchema>

/** Added by the deterministic grounding check, never by the model. */
export const findingCheckSchema = z.object({
  /** At least one cited excerpt exists in the context that was sent. */
  grounded: z.boolean(),
  /** Every number in the evidence appears in the cited (or, failing that, any) excerpt. */
  numbersVerified: z.boolean()
}).strict()
export type FindingCheck = z.infer<typeof findingCheckSchema>

/** Stored record: model output plus provenance, so stale or unverifiable briefs are visible. */
export const paperBriefSchema = paperBriefContentSchema.extend({
  schemaVersion: z.literal(PAPER_BRIEF_SCHEMA_VERSION),
  checks: z.array(findingCheckSchema).max(6),
  provenance: z.object({
    promptVersion: text(64),
    model: z.object({ provider: z.enum(['qwen', 'deepseek']), name: text(80) }).strict(),
    generatedAt: z.iso.datetime(),
    /** Same meaning as the v1 insight: artifact revisions of the parsed/translated Markdown. */
    sourceRevision: text(512),
    language: z.enum(['original', 'translated']),
    sentBytes: z.number().int().nonnegative(),
    sourceBytes: z.number().int().nonnegative()
  }).strict()
}).strict().refine((brief) => brief.checks.length === brief.findings.length, { message: 'checks 必须与 findings 一一对应' })
export type PaperBrief = z.infer<typeof paperBriefSchema>
