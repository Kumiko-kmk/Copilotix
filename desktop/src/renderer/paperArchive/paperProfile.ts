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

export function archiveTranslatedTitle(translatedMarkdown: string | null | undefined): string {
  return translatedMarkdown ? extractPaperProfile('', translatedMarkdown).translatedTitle?.replace(/\.pdf\s*$/iu, '').trim() ?? '' : ''
}

export function extractPaperProfile(markdown: string, translatedMarkdown = ''): PaperProfile {
  const source = splitBlocks(markdown)
  const translated = splitBlocks(translatedMarkdown)
  const primary = source.length ? source : translated
  const translatedKeywords = keywordsOf(translated)
  return {
    title: firstTitle(source),
    translatedTitle: firstTitle(translated),
    authors: authorLines(primary),
    abstract: abstractOf(source),
    translatedAbstract: abstractOf(translated),
    keywords: translatedKeywords.length ? translatedKeywords : keywordsOf(source),
    sections: sectionsOf(translated.length ? translated : source),
    counts: countsOf(markdown || translatedMarkdown, primary)
  }
}

function splitBlocks(markdown: string): Block[] {
  const blocks: Block[] = []
  for (const raw of markdown.replace(/\r\n?/gu, '\n').split(/\n{2,}/u)) {
    const text = raw.trim()
    if (!text) continue
    const heading = /^(#{1,6})\s+(.+)$/su.exec(text)
    blocks.push(heading ? { heading: heading[1]!.length, text: cleanInline(heading[2]!) } : { heading: 0, text })
  }
  return blocks
}

/** Strip Markdown and HTML decoration down to readable text. */
export function cleanInline(text: string, preserveLinks = false): string {
  const destinations: string[] = []
  if (preserveLinks) {
    // Autolinks look like HTML tags to the generic cleaner. Keep their destinations;
    // descriptive Markdown and HTML links also need the URL in an abstract.
    text = text.replace(/<(https?:\/\/[^<>\s]+)>/giu, '$1')
      .replace(/<a\b[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu,
        (_, url: string, label: string) => label.trim() === url ? url : `${label} (${url})`)
      .replace(/(?<!!)\[([^\]]*)\]\((https?:\/\/[^\s)]+)(?:\s+["'][^"']*["'])?\)/giu,
        (_, label: string, url: string) => !label.trim() || label.trim() === url ? url : `${label} (${url})`)
    text = text.replace(/https?:\/\/[^\s<>]+/giu, (url) => {
      destinations.push(url)
      return `\uE000${destinations.length - 1}\uE001`
    })
  }
  return text
    .replace(/<sup>.*?<\/sup>/giu, '')
    // Real tags only, so a bare `<` in maths cannot swallow the rest of the paragraph.
    .replace(/<\/?[A-Za-z][^<>\n]{0,300}>/gu, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, '')
    .replace(/\[([^\]]*)\]\((?:mailto:)?[^)]*\)/gu, '$1')
    .replace(/[*_`]{1,3}([^*_`]+)[*_`]{1,3}/gu, '$1')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/\uE000(\d+)\uE001/gu, (_, index: string) => destinations[Number(index)] ?? '')
}

function firstTitle(blocks: Block[]): string | null {
  const title = blocks.find((block) => block.heading > 0 && !ABSTRACT_HEADING.test(block.text))
  return title ? title.text : null
}

function abstractStart(blocks: Block[]): number {
  return blocks.findIndex((block) => (block.heading > 0 && ABSTRACT_HEADING.test(block.text)) ||
    (block.heading === 0 && ABSTRACT_INLINE.test(block.text) && block.text.length > 40))
}

function abstractOf(blocks: Block[]): string | null {
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
  const text = cleanInline(parts.join('\n\n'), true)
  if (!text) return null
  return text.length > MAX_ABSTRACT ? `${text.slice(0, MAX_ABSTRACT).trimEnd()}…` : text
}

function authorLines(blocks: Block[]): string | null {
  const title = blocks.findIndex((block) => block.heading > 0 && !ABSTRACT_HEADING.test(block.text))
  const end = abstractStart(blocks)
  if (title < 0 || end <= title) return null
  const lines = blocks.slice(title + 1, end)
    .filter((block) => block.heading === 0 && block.text.length < 600 && !/^\$\$|^!\[|^<table/iu.test(block.text))
    .map((block) => cleanInline(block.text)
      // E-mail addresses (grouped {a,b}@host first), including translated non-ASCII domains.
      .replace(/\{[^}]*\}@\S+/gu, '')
      .replace(/[^\s;；,，]+@[^\s;；,，]+/gu, '')
      .replace(/[∗*†‡§¶]+/gu, '')
      .replace(/\s+([,，;；])/gu, '$1')
      .replace(/\s+/gu, ' ')
      .trim())
    .filter(Boolean)
  if (!lines.length) return null
  const text = lines.slice(0, 6).join('；')
  return text.length > 320 ? `${text.slice(0, 320).trimEnd()}…` : text
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
