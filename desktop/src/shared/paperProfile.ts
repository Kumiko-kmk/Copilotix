import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { prepareReaderMarkdown } from '@shared/standardMarkdown'

const inlineParser = unified().use(remarkParse).use(remarkGfm).use(remarkMath)

/**
 * Structured facts about a paper, read from its parsed (and translated) Markdown.
 * Only paper content is used; import time, file paths and job state are not part of it.
 */
export interface PaperProfile {
  title: string | null
  translatedTitle: string | null
  /** Author and affiliation lines between the title and the abstract, cleaned of e-mail and note marks. */
  authors: string | null
  abstract: string | null
  translatedAbstract: string | null
  keywords: string[]
  /** Top-level sections in reading order, preferring the translated headings. */
  sections: string[]
  counts: { figures: number; tables: number; equations: number; references: number }
}

interface Block {
  heading: number
  text: string
}

const ABSTRACT_HEADING = /^(?:abstract|summary|摘要|摘\s*要)[.:：]?$/iu
const ABSTRACT_INLINE = /^(?:\*\*|__)?(?:abstract|摘要)(?:\*\*|__)?\s*(?:[.:：|—–-]|\s{1,2})\s*/iu
const KEYWORDS_INLINE = /^(?:\*\*|__)?(?:key\s?words|index\s+terms|关键词|关键字|關鍵詞)(?:\*\*|__)?\s*[:：—–-]\s*/iu
const REFERENCES_HEADING = /^(?:references|bibliography|参考文献|參考文獻)$/iu
const BACK_MATTER_HEADING = /^(?:acknowledg(?:e)?ments?|致谢|致謝|appendix|附录|附錄)/iu
const SECTION_NUMBER = /^(?:\d+|[IVXLC]+)(?:\.\d+)+[.\s]/u
const MAX_ABSTRACT = 1600
const MAX_SECTIONS = 12

/**
 * The titles the archive shows for a paper. The browse panel and the detail header must use these
 * same two functions: the header's titles glide out of the panel's, and any difference in text
 * appears as the title being redrawn mid-transition.
 */
export function archiveTitle(displayName: string): string {
  return displayName.replace(/\.pdf\s*$/iu, '').trim()
}

export function archiveTranslatedTitle(translatedMarkdown: string | null | undefined, preserveMath = false): string {
  return translatedMarkdown ? extractPaperProfile('', translatedMarkdown, preserveMath).translatedTitle?.replace(/\.pdf\s*$/iu, '').trim() ?? '' : ''
}

export function extractPaperProfile(markdown: string, translatedMarkdown = '', preserveMath = false): PaperProfile {
  const source = splitBlocks(markdown, preserveMath)
  const translated = splitBlocks(translatedMarkdown, preserveMath)
  const primary = source.length ? source : translated
  const translatedKeywords = keywordsOf(translated)
  return {
    title: firstTitle(source),
    translatedTitle: firstTitle(translated),
    authors: authorLines(primary),
    abstract: abstractOf(source, preserveMath),
    translatedAbstract: abstractOf(translated, preserveMath),
    keywords: translatedKeywords.length ? translatedKeywords : keywordsOf(source),
    sections: sectionsOf(translated.length ? translated : source),
    counts: countsOf(markdown || translatedMarkdown, primary)
  }
}

function splitBlocks(markdown: string, preserveMath: boolean): Block[] {
  const blocks: Block[] = []
  for (const raw of markdown.replace(/\r\n?/gu, '\n').split(/\n{2,}/u)) {
    const text = raw.trim()
    if (!text) continue
    const heading = /^(#{1,6})\s+(.+)$/su.exec(text)
    blocks.push(heading ? { heading: heading[1]!.length, text: cleanInline(heading[2]!, false, preserveMath) } : { heading: 0, text })
  }
  return blocks
}

/** Strip Markdown and HTML decoration down to readable text. */
export function cleanInline(text: string, preserveLinks = false, preserveMath = false): string {
  const prepared = text
    .replace(/<sup>.*?<\/sup>/gisu, '')
    .replace(/<(https?:\/\/[^<>\s]+)>/giu, '$1')
    .replace(/<a\b[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu,
      (_, url: string, label: string) => `[${label}](${url})`)
    // Real tags only, so a bare `<` in maths cannot swallow the rest of the paragraph.
    .replace(/<\/?[A-Za-z][^<>\n]{0,300}>/gu, '')
  return projectInline(inlineParser.parse(preserveMath ? prepareReaderMarkdown(prepared) : prepared), preserveLinks, preserveMath).replace(/\s+/gu, ' ').trim()
}

interface InlineNode { type: string; value?: string; url?: string; children?: InlineNode[] }

function projectInline(node: InlineNode, preserveLinks: boolean, preserveMath: boolean): string {
  if (node.type === 'image' || node.type === 'imageReference') return ''
  if (preserveMath && (node.type === 'inlineMath' || node.type === 'math')) return `$${node.value ?? ''}$`
  if (preserveMath && node.type === 'inlineCode') return `\`${node.value ?? ''}\``
  if (node.value !== undefined) return node.value
  const text = (node.children ?? []).map(child => projectInline(child, preserveLinks, preserveMath)).join(node.type === 'root' ? ' ' : '')
  if (preserveLinks && node.type === 'link' && node.url && /^https?:\/\//iu.test(node.url)) {
    return !text || text === node.url ? node.url : `${text} (${node.url})`
  }
  return text
}

function firstTitle(blocks: Block[]): string | null {
  const title = blocks.find((block) => block.heading > 0 && !ABSTRACT_HEADING.test(block.text))
  return title ? title.text : null
}

function abstractStart(blocks: Block[]): number {
  const explicit = blocks.findIndex((block) => (block.heading > 0 && ABSTRACT_HEADING.test(block.text)) ||
    (block.heading === 0 && ABSTRACT_INLINE.test(block.text) && block.text.length > 40))
  if (explicit >= 0) return explicit
  // Journals can put an unlabelled abstract immediately after the byline.
  // Never search through Contents/Introduction or treat a long author list as prose.
  const title = blocks.findIndex(block => block.heading > 0)
  let byline = false
  for (let index = title + 1; title >= 0 && index < Math.min(blocks.length, title + 25); index++) {
    const block = blocks[index]!
    if (block.heading > 0) break
    const text = cleanAuthorLine(block.text)
    if (looksLikeByline(text)) { byline = true; continue }
    if (!byline || isFrontMatterMetadata(text) || isAffiliation(text) || /^!\[|^<table|^\$\$/iu.test(block.text)) continue
    if (text.length >= 160 && (text.split(/\s+/u).length >= 25 || (text.match(/\p{Script=Han}/gu)?.length ?? 0) >= 80)) return index
  }
  return -1
}

function abstractOf(blocks: Block[], preserveMath: boolean): string | null {
  const start = abstractStart(blocks)
  if (start < 0) return null
  const first = blocks[start]!
  const parts: string[] = []
  if (first.heading === 0) parts.push(first.text.replace(ABSTRACT_INLINE, ''))
  else {
    for (const block of blocks.slice(start + 1)) {
      if (block.heading > 0 || KEYWORDS_INLINE.test(block.text)) break
      parts.push(block.text)
      if (parts.join(' ').length > MAX_ABSTRACT) break
    }
  }
  const text = cleanInline(parts.join('\n\n'), true, preserveMath)
  if (!text) return null
  return text.length > MAX_ABSTRACT ? `${text.slice(0, MAX_ABSTRACT).trimEnd()}…` : text
}

function cleanAuthorLine(text: string): string {
  return cleanInline(text)
    .replace(/\{[^}]*\}@\S+/gu, '')
    .replace(/[^\s;；,，]+@[^\s;；,，]+/gu, '')
    .replace(/https?:\/\/\S+/gu, '')
    .replace(/[∗*†‡§¶✉]+/gu, '')
    .replace(/\s+([,，;；])/gu, '$1')
    .replace(/\s+/gu, ' ').trim()
}

function isFrontMatterMetadata(text: string): boolean {
  return /^(?:article|review|open access|check for updates|received\b|accepted\b|published\b|revised\b|copyright\b|correspond(?:ence|ing)\b|contributing authors?\s*:|https?:|doi\s*:|arxiv\b)/iu.test(text) ||
    /^(?:(?:\d{1,2}\s+)?(?:january|february|march|april|may|june|july|august|september|october|november|december)\b|\d{4}[-年/]\d)/iu.test(text)
}

function isAffiliation(text: string): boolean {
  return /^(?:\d+[.)]?\s*)?(?:department|division|school|faculty|institute|university|laboratory|laboratoire|nvidia\b|deepmind\b|data61\b)/iu.test(text) ||
    /^(?:\d+\s*)?[\p{Script=Han}]{2,30}(?:大学|大學|学院|學院|研究所|研究院)/u.test(text)
}

function looksLikeByline(text: string): boolean {
  if (!text || text.length > 4000 || isFrontMatterMetadata(text) || isAffiliation(text)) return false
  if (/\b(?:is|are|was|were|we|our|this|the|propose|presents|shows|has|have|permission|rights|abstract)\b/iu.test(text)) return false
  const names = text.match(/(?:^|[\s,;，；&])\p{Lu}[\p{L}\p{M}.'’-]*/gu) ?? []
  const words = text.match(/\p{L}[\p{L}\p{M}.'’-]*/gu) ?? []
  if (names.length >= 2 && names.length / words.length >= 0.4) return true
  const chinese = text.split(/[\s,，、;；&]+/u).filter(Boolean)
  return chinese.length > 0 && chinese.every(name => /^[\p{Script=Han}·]{2,8}$/u.test(name)) && !/研究|方法|论文|論文|摘要|本文|结果|結果/u.test(text)
}

function authorLines(blocks: Block[]): string | null {
  const title = blocks.findIndex((block) => block.heading > 0 && !ABSTRACT_HEADING.test(block.text))
  if (title < 0) return null
  const abstract = abstractStart(blocks)
  const section = blocks.findIndex((block, index) => index > title && block.heading > 0)
  const end = Math.min(abstract > title ? abstract : blocks.length, section > title ? section : blocks.length, title + 25)
  const candidates = blocks.slice(title + 1, end)
    .filter(block => !/^\$\$|^!\[|^<table/iu.test(block.text))
    .map(block => cleanAuthorLine(block.text))
    .filter(text => text.length <= 4000 && /\p{L}/u.test(text) && !isFrontMatterMetadata(text))
  if (!candidates.some(looksLikeByline)) return null
  const lines: string[] = []
  for (const text of candidates) {
    if (looksLikeByline(text) || (lines.length > 0 && isAffiliation(text))) lines.push(text)
  }
  return lines.length ? lines.join('；') : null
}

function keywordsOf(blocks: Block[]): string[] {
  for (const block of blocks.slice(0, 40)) {
    if (block.heading > 0 || !KEYWORDS_INLINE.test(block.text)) continue
    return cleanInline(block.text.replace(KEYWORDS_INLINE, ''))
      .split(/[,;，；、·•]|\s—\s/u)
      .map((keyword) => keyword.replace(/[.。]$/u, '').trim())
      .filter((keyword) => keyword.length > 0 && keyword.length < 60)
      .slice(0, 10)
  }
  return []
}

function sectionsOf(blocks: Block[]): string[] {
  const title = blocks.findIndex((block) => block.heading > 0 && !ABSTRACT_HEADING.test(block.text))
  const sections: string[] = []
  for (const block of blocks.slice(title + 1)) {
    if (block.heading === 0 || ABSTRACT_HEADING.test(block.text)) continue
    if (REFERENCES_HEADING.test(block.text) || BACK_MATTER_HEADING.test(block.text)) break
    // MinerU emits every heading at one level, so numbering tells sections from subsections.
    if (SECTION_NUMBER.test(`${block.text} `)) continue
    sections.push(block.text)
    if (sections.length >= MAX_SECTIONS) break
  }
  return sections
}

function countsOf(markdown: string, blocks: Block[]): PaperProfile['counts'] {
  const figures = (markdown.match(/!\[[^\]]*\]\([^)]*\)/gu) ?? []).length
  const htmlTables = (markdown.match(/<table[\s>]/giu) ?? []).length
  const pipeTables = (markdown.match(/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/gmu) ?? []).length
  const equations = Math.floor((markdown.match(/(?:^|\n)\s*\$\$/gu) ?? []).length / 2) +
    (markdown.match(/^\s*```math\b/gmu) ?? []).length +
    (markdown.match(/\\begin\{(?:equation|align|gather)\*?\}/gu) ?? []).length
  const start = blocks.findIndex((block) => block.heading > 0 && REFERENCES_HEADING.test(block.text))
  let references = 0
  if (start >= 0) {
    for (const block of blocks.slice(start + 1)) {
      if (block.heading > 0) break
      const lines = block.text.split('\n').filter((line) => /^\s*(?:\[\d+\]|\d+\.\s|[-*]\s)/u.test(line))
      references += lines.length > 1 ? lines.length : 1
    }
  }
  return { figures, tables: htmlTables + pipeTables, equations, references }
}
