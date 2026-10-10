/**
 * Builds what is sent to the model for a paper brief: a byte-budgeted, role-aware digest
 * of the paper instead of its full text. Pure and runtime independent (Utility and tests).
 *
 * 1. Normalise MinerU Markdown: drop images, links, citation marks and long display math;
 *    flatten HTML tables to a few rows.
 * 2. Split into sections and give each an IMRaD role from its heading (English and Chinese
 *    lexicons), inheriting the parent's role for numbered subsections, with position fallbacks.
 * 3. Score paragraphs: role weight + cue phrases (contribution, result, limitation, definition)
 *    + numeric density for results + position (end of the introduction states contributions).
 * 4. Always send the abstract, the conclusion and the introduction's contribution paragraph;
 *    then give method, results, discussion and limitations at least one excerpt each; then
 *    fill the budget by score. Excerpts end on sentence boundaries and keep document order.
 * 5. Report coverage (roles seen, bytes sent, truncation) so the brief can say what it missed.
 */

export type SectionRole =
  | 'front' | 'abstract' | 'introduction' | 'background' | 'method' | 'results'
  | 'discussion' | 'limitations' | 'conclusion' | 'body' | 'caption'

export interface BriefExcerpt {
  /** Stable within one context: E1, E2, … in document order. Findings cite these. */
  id: string
  section: string
  role: SectionRole
  text: string
}

export interface BriefContext {
  title: string | null
  language: 'original' | 'translated'
  /** Every top-level and sub-section heading, so the model sees the whole structure. */
  outline: string[]
  excerpts: BriefExcerpt[]
  coverage: {
    roles: SectionRole[]
    missingRoles: SectionRole[]
    sourceBytes: number
    sentBytes: number
    truncated: boolean
  }
}

/** Input budgets in UTF-8 bytes (≈ an upper bound on tokens for mixed CJK/Latin text). */
// `detailed` is what the archive sends (2026-10-10): about 19 000 Chinese characters, roughly a
// third to a half of a typical translated paper once references and appendices are dropped.
export const BRIEF_BUDGETS = { compact: 12 * 1024, standard: 24 * 1024, extended: 40 * 1024, detailed: 56 * 1024 } as const

const encoder = new TextEncoder()
export const byteLength = (text: string): number => encoder.encode(text).length

const ROLE_LEXICON: Array<[SectionRole, RegExp]> = [
  ['abstract', /^(?:abstract|summary|摘\s*要|内容提要)$/iu],
  ['limitations', /limitation|threats? to validity|局限|不足之处|研究限制/iu],
  ['conclusion', /conclu|concluding|summary and|closing remarks|结论|总结|结语|小结/iu],
  ['discussion', /discussion|implication|讨论|启示|意义/iu],
  ['results', /result|experiment|evaluation|empirical|analysis|findings|performance|ablation|case stud|实验|结果|评估|评测|分析|实证|案例/iu],
  ['method', /method|approach|model|framework|architecture|design|algorithm|materials|procedure|proposed|formulation|theory|proof|数据与方法|方法|模型|框架|架构|设计|算法|材料|理论|证明|研究设计/iu],
  ['background', /related work|background|literature|preliminar|prior work|相关工作|背景|文献综述|预备知识|研究现状/iu],
  ['introduction', /introduction|motivation|overview|引言|导论|绪论|简介|前言|研究背景与意义/iu]
]
const DROP_SECTION = /^(?:references?|bibliography|works cited|acknowledg(?:e)?ments?|appendi(?:x|ces)|supplementary|author contributions?|funding|conflicts? of interest|competing interests|data availability|ethics statement|参考文献|參考文獻|致谢|致謝|附录|附錄|补充材料|作者贡献|基金|利益冲突|数据可用性)(?![A-Za-z])/iu
const CAPTION = /^(?:fig(?:ure)?\.?|table|tab\.|图|表)\s*[\dIVX]+\s*[.:：|]?/iu
const SECTION_NUMBER = /^((?:\d+|[IVXLC]+))(?:\.(\d+))*[.\s]/u
// Real tags only: a bare `<` in maths ("a < b … c > d") must not swallow the text between them.
const HTML_TAG = /<\/?[A-Za-z][^<>\n]{0,300}>/gu

const CUES: Array<[RegExp, number]> = [
  // Contribution statements, usually at the end of the introduction.
  [/\b(?:we (?:propose|present|introduce|develop|show|demonstrate|argue|find|prove)|our (?:contributions?|main|key|results?)|in this (?:paper|work|study|article))\b|本文(?:提出|研究|探讨|发现|证明|构建)|我们(?:提出|发现|证明|构建|设计)|主要贡献|本研究/iu, 3],
  // Results and comparisons.
  [/\b(?:outperform|improv|achiev|significant|reduc|increas|accuracy|state[- ]of[- ]the[- ]art|compared (?:to|with)|baseline|p\s*[<=]|confidence interval|effect size)\w*|显著|提升|提高|降低|优于|超过|准确率|结果表明|实验表明|相比|基线/iu, 2],
  // Limitations and caveats.
  [/\b(?:limitation|however|fail(?:s|ed)? to|cannot|does not|future work|remain(?:s)? (?:open|unclear))\b|局限|不足|然而|未能|无法|有待|未来工作/iu, 2],
  // Definitions of key terms.
  [/\b(?:we define|is defined as|refers to|we call)\b|定义为|称为|是指/iu, 1]
]
const ROLE_WEIGHT: Record<SectionRole, number> = {
  abstract: 10, conclusion: 6, limitations: 6, discussion: 4, results: 4, introduction: 3,
  method: 3, body: 2, caption: 3, background: 1, front: 0
}
// Longer excerpts keep a method or result paragraph whole, so the model sees conditions and numbers together.
const EXCERPT_CAP = 1100
const MANDATORY_CAP: Partial<Record<SectionRole, number>> = { abstract: 3000, conclusion: 2600 }
const QUOTA_ROLES: SectionRole[] = ['method', 'results', 'discussion', 'limitations']
const MAX_EXCERPTS = 96
// After the mandatory excerpts, no single role may take more than this share of the budget,
// so results-heavy papers still show their method and discussion.
const FILL_SHARE: Record<SectionRole, number> = {
  results: 0.3, method: 0.26, body: 0.14, introduction: 0.12, discussion: 0.1, limitations: 0.08,
  caption: 0.08, conclusion: 0.06, background: 0.04, abstract: 0, front: 0
}
const MERGE_BELOW = 160
const OUTLINE_CAP = 3200

interface Paragraph {
  order: number
  section: string
  role: SectionRole
  text: string
  score: number
  first: boolean
  last: boolean
}

/** Prefer the original text (no translation loss); fall back to the translation. */
export function buildBriefContext(original: string, translated: string, budgetBytes: number = BRIEF_BUDGETS.standard): BriefContext {
  const useOriginal = original.trim().length > 0
  const markdown = useOriginal ? original : translated
  const { title, sections } = segment(normalizeMarkdown(markdown))
  const outline = takeOutline(sections.map((section) => section.heading).filter((heading): heading is string => Boolean(heading)))
  const paragraphs = scoreParagraphs(sections)
  const roles = [...new Set(paragraphs.map((paragraph) => paragraph.role))]
  let remaining = Math.max(2048, budgetBytes) - byteLength(outline.join('\n')) - byteLength(title ?? '')
  const chosen = new Map<number, string>()
  let truncated = false

  const take = (paragraph: Paragraph | undefined, cap: number): void => {
    if (!paragraph || chosen.has(paragraph.order) || chosen.size >= MAX_EXCERPTS) return
    const overhead = byteLength(paragraph.section) + 24
    if (remaining - overhead < 120) {
      truncated = true
      return
    }
    const text = clip(paragraph.text, Math.min(cap, remaining - overhead))
    if (!text) return
    truncated ||= text.length < paragraph.text.length
    chosen.set(paragraph.order, text)
    remaining -= overhead + byteLength(text)
  }
  const best = (role: SectionRole, filter: (paragraph: Paragraph) => boolean = () => true): Paragraph | undefined =>
    paragraphs.filter((paragraph) => paragraph.role === role && !chosen.has(paragraph.order) && filter(paragraph))
      .sort((a, b) => b.score - a.score || a.order - b.order)[0]

  // 1. Abstract and conclusion in full (to their caps), in reading order.
  for (const role of ['abstract', 'conclusion'] as const) {
    let budget = MANDATORY_CAP[role]!
    for (const paragraph of paragraphs.filter((item) => item.role === role)) {
      if (budget <= 120) {
        truncated = true
        break
      }
      const before = remaining
      take(paragraph, Math.min(EXCERPT_CAP * 2, budget))
      budget -= before - remaining
    }
  }
  // 2. The introduction's contribution statement: the best-scoring of its last paragraphs.
  take(best('introduction', (paragraph) => paragraph.last) ?? best('introduction'), 1400)
  take(best('introduction'), EXCERPT_CAP)
  // 3. At least one excerpt for each remaining IMRaD role that the paper has.
  for (const role of QUOTA_ROLES) take(best(role), EXCERPT_CAP)
  // 4. Fill by score within per-role shares; captions are short and carry results.
  const fillBudget = remaining
  const used = new Map<SectionRole, number>()
  const rest = paragraphs.filter((paragraph) => !chosen.has(paragraph.order) && paragraph.score > 0)
    .sort((a, b) => b.score - a.score || a.text.length - b.text.length || a.order - b.order)
  for (const paragraph of rest) {
    if (remaining < 200 || chosen.size >= MAX_EXCERPTS) {
      truncated = true
      break
    }
    const share = FILL_SHARE[paragraph.role] * fillBudget - (used.get(paragraph.role) ?? 0)
    if (share < 160) continue
    const before = remaining
    take(paragraph, Math.min(paragraph.role === 'caption' ? 320 : EXCERPT_CAP, share))
    used.set(paragraph.role, (used.get(paragraph.role) ?? 0) + before - remaining)
  }
  // 5. When the shares leave much of the budget unused (short or one-sided papers), relax them.
  if (remaining > fillBudget * 0.25) {
    for (const paragraph of rest) {
      if (remaining < 200 || chosen.size >= MAX_EXCERPTS) break
      take(paragraph, paragraph.role === 'caption' ? 320 : EXCERPT_CAP)
    }
  }
  truncated ||= rest.some((paragraph) => !chosen.has(paragraph.order) && paragraph.score >= 4)

  const excerpts = paragraphs.filter((paragraph) => chosen.has(paragraph.order))
    .map((paragraph, index) => ({ id: `E${index + 1}`, section: paragraph.section, role: paragraph.role, text: chosen.get(paragraph.order)! }))
  const sentBytes = byteLength(JSON.stringify({ title, outline, excerpts }))
  return {
    title,
    language: useOriginal ? 'original' : 'translated',
    outline,
    excerpts,
    coverage: {
      roles,
      missingRoles: (['abstract', 'introduction', 'method', 'results', 'conclusion'] as const).filter((role) => !roles.includes(role)),
      sourceBytes: byteLength(markdown),
      sentBytes,
      truncated
    }
  }
}

/** Strip what carries no meaning for a summary; keep table text as compact rows. */
export function normalizeMarkdown(markdown: string): string {
  return markdown
    .replace(/\r\n?/gu, '\n')
    .replace(/<table[\s\S]*?<\/table>/giu, (table) => {
      const rows = table.split(/<\/tr>/iu).map((row) => row.replace(/<\/t[dh]>/giu, ' | ').replace(HTML_TAG, '').replace(/\s+/gu, ' ').replace(/\s*\|\s*$/u, '').trim()).filter(Boolean)
      return `\n\n表格：${rows.slice(0, 8).join(' ／ ')}${rows.length > 8 ? ' ／ …' : ''}\n\n`
    })
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/<sup>[^<]{0,12}<\/sup>/giu, '')
    .replace(HTML_TAG, '')
    .replace(/\$\$([\s\S]*?)\$\$/gu, (_, body: string) => body.trim().length <= 160 ? ` $${body.trim()}$ ` : ' [公式] ')
    .replace(/\\?\[\d+(?:\s*[,–-]\s*\d+)*\\?\]/gu, '')
    .replace(/[ \t]+/gu, ' ')
}

interface Section {
  heading: string | null
  role: SectionRole
  paragraphs: string[]
}

function segment(markdown: string): { title: string | null; sections: Section[] } {
  const sections: Section[] = []
  let title: string | null = null
  let current: Section = { heading: null, role: 'front', paragraphs: [] }
  const parents = new Map<string, SectionRole>()
  let dropping = false
  for (const block of markdown.replace(/^(#{1,6}[^\S\n]+[^\n]+)$/gmu, '\n\n$1\n\n').split(/\n{2,}/u).map((part) => part.trim()).filter(Boolean)) {
    const heading = /^#{1,6}\s+(.+)$/su.exec(block)
    if (!heading) {
      if (dropping) continue
      // An unmarked "Abstract —" paragraph starts the abstract.
      if (current.role === 'front' && /^(?:\*\*)?(?:abstract|摘要)(?:\*\*)?\s*[.:：—–-]/iu.test(block)) {
        sections.push(current)
        current = { heading: 'Abstract', role: 'abstract', paragraphs: [block.replace(/^(?:\*\*)?(?:abstract|摘要)(?:\*\*)?\s*[.:：—–-]\s*/iu, '')] }
        continue
      }
      current.paragraphs.push(block)
      continue
    }
    const text = heading[1]!.replace(/\s+/gu, ' ').trim()
    if (title === null && !/^(?:abstract|摘要)$/iu.test(text)) {
      title = text
      continue
    }
    sections.push(current)
    const bare = text.replace(SECTION_NUMBER, '').trim()
    dropping = DROP_SECTION.test(bare)
    const number = SECTION_NUMBER.exec(`${text} `)
    const lexicon = ROLE_LEXICON.find(([, pattern]) => pattern.test(bare))?.[0]
    const parent = number?.[2] !== undefined ? parents.get(number[1]!) : undefined
    const role: SectionRole = lexicon ?? parent ?? 'body'
    if (number && number[2] === undefined) parents.set(number[1]!, role)
    current = { heading: text, role, paragraphs: [] }
    if (dropping) current.paragraphs = []
  }
  sections.push(current)
  // Journals such as Nature print the abstract as the first long paragraph after the authors.
  if (!sections.some((section) => section.role === 'abstract')) {
    const front = sections.find((section) => section.role === 'front')
    const index = front ? front.paragraphs.findIndex((paragraph) => paragraph.length >= 300 && !paragraph.includes('@')) : -1
    if (front && index >= 0) {
      sections.splice(sections.indexOf(front) + 1, 0, { heading: 'Abstract', role: 'abstract', paragraphs: [front.paragraphs[index]!] })
      front.paragraphs.splice(index, 1)
    }
  }
  const kept = sections.filter((section) => section.heading === null || !DROP_SECTION.test(section.heading.replace(SECTION_NUMBER, '').trim()))
  // Position fallbacks: an unnamed first section is the introduction, an unnamed last one the conclusion.
  const body = kept.filter((section) => !['front', 'abstract'].includes(section.role))
  if (body[0]?.role === 'body' && !kept.some((section) => section.role === 'introduction')) body[0].role = 'introduction'
  const last = body[body.length - 1]
  if (last && body.length > 2 && last.role === 'body' && !kept.some((section) => section.role === 'conclusion')) last.role = 'conclusion'
  return { title, sections: kept }
}

/** Join runs of short paragraphs (list items, one-line statements) so they form one excerpt. */
function mergeShort(paragraphs: string[]): string[] {
  const merged: string[] = []
  for (const paragraph of paragraphs) {
    const previous = merged[merged.length - 1]
    if (previous !== undefined && (previous.length < MERGE_BELOW || paragraph.length < MERGE_BELOW) &&
      previous.length + paragraph.length < 600 && !CAPTION.test(paragraph) && !CAPTION.test(previous)) {
      merged[merged.length - 1] = `${previous} ${paragraph}`
    } else merged.push(paragraph)
  }
  return merged
}

function scoreParagraphs(sections: Section[]): Paragraph[] {
  const paragraphs: Paragraph[] = []
  let order = 0
  for (const section of sections) {
    if (section.role === 'front') continue
    const label = section.heading ?? '正文'
    section.paragraphs = mergeShort(section.paragraphs)
    section.paragraphs.forEach((raw, index) => {
      const text = raw.replace(/\s+/gu, ' ').trim()
      if (!text) return
      const caption = CAPTION.test(text) || text.startsWith('表格：')
      const role: SectionRole = caption ? 'caption' : section.role
      let score = ROLE_WEIGHT[role]
      for (const [pattern, weight] of CUES) if (pattern.test(text)) score += weight
      if (role === 'results' || caption) score += Math.min(2, (text.match(/\d+(?:\.\d+)?%?/gu) ?? []).length / 4)
      if (index === 0) score += 1
      const last = index === section.paragraphs.length - 1
      if (last && role === 'introduction') score += 2
      if (text.length < 40 && !caption) score -= 2
      if (/^\$.*\$$/u.test(text) || /^\[公式\]$/u.test(text)) score -= 3
      paragraphs.push({ order: order++, section: label, role, text, score, first: index === 0, last })
    })
  }
  return paragraphs
}

function takeOutline(headings: string[]): string[] {
  const outline: string[] = []
  let bytes = 0
  for (const heading of headings) {
    const size = byteLength(heading) + 1
    if (bytes + size > OUTLINE_CAP) break
    outline.push(heading)
    bytes += size
  }
  return outline
}

/** Cut to at most `maxBytes`, ending on a sentence boundary when one is reasonably close. */
export function clip(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  if (byteLength(text) <= maxBytes) return text
  let end = 0
  let bytes = 0
  for (const character of text) {
    const size = byteLength(character)
    if (bytes + size > maxBytes - 3) break
    bytes += size
    end += character.length
  }
  const head = text.slice(0, end)
  const boundary = Math.max(...['。', '！', '？', '；', '. ', '! ', '? ', '; '].map((mark) => head.lastIndexOf(mark)))
  return boundary > end * 0.5 ? head.slice(0, boundary + 1).trim() : `${head.trimEnd()}…`
}
