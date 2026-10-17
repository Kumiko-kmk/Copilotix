import { cleanInline, extractPaperProfile } from '../paperProfile'
import type { BriefContext } from './context'
import type { PaperMetadata } from './schema'

export const METADATA_FIELDS = ['title', 'authors', 'year', 'venue', 'doi'] as const
export type MetadataField = typeof METADATA_FIELDS[number]

/** Restrict bibliographic evidence to the paper's front matter, never its references. */
function frontMatter(context: BriefContext): string {
  const text = context.excerpts.map(excerpt => excerpt.text).join('')
  const headings = [...text.matchAll(/^#{1,6}\s+(.+)$/gmu)]
  const end = headings.slice(1).find(heading => !/^(?:authors?|affiliations?|author information|publication|作者(?:信息|資訊)?|单位|單位)(?:\s|[:：]|$)/iu.test(heading[1]!))?.index
  return text.slice(0, Math.min(end ?? text.length, 12000))
}

/** Same extractor as the archive; no duplicate Main/Renderer author heuristics. */
export function localPaperMetadata(context: BriefContext): Record<MetadataField, string | null> {
  const source = frontMatter(context)
  const front = cleanInline(source)
  const profile = extractPaperProfile(source)
  const candidate = profile.title ?? context.title
  const title = candidate && !/^(?:\d{4}\.\d{4,5}(?:v\d+)?(?:\.pdf)?|authors?|affiliations?|abstract|introduction|作者|摘要)$/iu.test(candidate) ? candidate : null
  const doi = /\b10\.\d{4,9}\/[^\s<>]+/iu.exec(front)?.[0]?.replace(/[.,;]+$/u, '') ?? null
  const year = /\b(?:published(?: online)?|publication date|出版日期|发表日期|發表日期)\s*[:：]?[^\n]{0,45}?\b((?:19|20)\d{2})\b/iu.exec(front)?.[1] ?? null
  return { title, authors: profile.authors, year, venue: null, doi }
}

const normalize = (value: string): string => cleanInline(value).normalize('NFKC').toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}]+/gu, '')

/** Missing-only recovery. Unsupported answers are discarded without failing the analysis. */
export function groundPaperMetadata(metadata: PaperMetadata, context: BriefContext): PaperMetadata {
  const local = localPaperMetadata(context)
  const front = normalize(frontMatter(context))
  const excerpts = new Map(context.excerpts.map(excerpt => [excerpt.id, excerpt.text]))
  return Object.fromEntries(METADATA_FIELDS.map(field => {
    const fact = metadata[field]
    if (local[field] || !fact) return [field, null]
    const evidence = normalize(fact.evidence)
    const cited = normalize(fact.anchors.map(id => excerpts.get(id) ?? '').join(''))
    const value = normalize(fact.value)
    const formatValid = field === 'year' ? /^(?:19|20)\d{2}$/u.test(fact.value)
      : field === 'doi' ? /^10\.\d{4,9}\/\S+$/u.test(fact.value) : true
    const verified = formatValid && evidence.length >= value.length && value.length > 0 &&
      front.includes(evidence) && cited.includes(evidence) && evidence.includes(value) &&
      fact.anchors.every(id => excerpts.has(id))
    return [field, verified ? { ...fact, value: cleanInline(fact.value), anchors: [...new Set(fact.anchors)] } : null]
  })) as PaperMetadata
}
