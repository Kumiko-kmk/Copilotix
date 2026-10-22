import { displayPaperTitle } from './titleNaming'

/**
 * Dropping the first page rewrites the PDF in the Utility (pdf-lib holds the whole file and its
 * object graph in memory), so it is offered only up to this size. Journal articles are far below.
 */
export const MAX_PDF_CROP_BYTES = 64 * 1024 * 1024

/** Per-file choices from the import confirmation, aligned with the selected files. */
export interface ImportFileOptions {
  /** Drop page 1 (for example an institutional repository cover) before the PDF is stored. */
  skipFirstPage?: boolean
  /** The PDF's own Info/XMP title as read by the renderer; Main checks it again before use. */
  metadataTitle?: string
}

const AUTHORING_TOOL = /^(?:microsoft\s+)?(?:word|powerpoint|excel)\s*[-–:]|^(?:untitled|无标题|未命名)|\b(?:use style|template|instructions? for authors?)\b/iu
const FILE_NAME = /\.(?:docx?|dotx?|rtf|odt|pdf|tex|dvi|ps|eps|indd|pptx?|xlsx?|txt)\s*$/iu
const PLACEHOLDER = /^(?:title|document|manuscript|paper|article|untitled document|slide \d+|pdf|main|draft|preprint|accepted manuscript|author'?s? manuscript|revised manuscript|final version|camera[- ]ready|cover page|full text|untitled\d*)$/iu
const IDENTIFIER = /^(?:doi\b|https?:|www\.|arxiv:|pii\b|s\d{4}-?\d{3,}|[a-z]{1,6}[-_ ]?\d{3,}(?:[-_.]\w+)*$)/iu

/**
 * Accepts a PDF metadata title only when it reads like a paper title. Authoring tools leave
 * "Microsoft Word - draft_v3.docx", file names, template text or journal codes in this field, and
 * a wrong title is worse than the file name until the parsed title replaces it.
 */
export function trustedPdfMetadataTitle(raw: string | null | undefined, fileName = ''): string | null {
  if (typeof raw !== 'string') return null
  const title = displayPaperTitle(raw.replace(/�/gu, ''))
  if (!title || title.length > 300) return null
  if (AUTHORING_TOOL.test(title) || FILE_NAME.test(title) || PLACEHOLDER.test(title) || IDENTIFIER.test(title)) return null
  const letters = title.match(/\p{L}/gu)?.length ?? 0
  const cjk = title.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0
  const words = title.split(/\s+/u).filter((word) => /\p{L}{2,}/u.test(word)).length
  // Latin titles need more than one real word; CJK titles are written without spaces.
  if (cjk < 6 && (words < 2 || letters < 8)) return null
  if (/[_]/u.test(title) && !/\s/u.test(title)) return null
  const stem = fileName.replace(/\.[^.]+$/u, '').trim().toLowerCase()
  if (stem && title.toLowerCase() === stem) return null
  return title
}

export interface CoverPageFinding {
  /** Repository or service that added the page, when the text names one. */
  source: string | null
}

/** Phrases that appear only on cover sheets added by a repository or a download service. */
const NAMED_COVERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/City Research Online/iu, 'City Research Online'],
  [/White Rose Research Online/iu, 'White Rose Research Online'],
  [/Edinburgh Research Explorer/iu, 'Edinburgh Research Explorer'],
  [/Explore Bristol Research/iu, 'Explore Bristol Research'],
  [/Nottingham ePrints/iu, 'Nottingham ePrints'],
  [/LSE Research Online/iu, 'LSE Research Online'],
  [/Enlighten\s*[–-]\s*Research publications/iu, 'Enlighten'],
  [/Permanent WRAP URL/iu, 'WRAP'],
  [/eScholarship\b[\s\S]{0,400}Permalink/iu, 'eScholarship'],
  [/HAL Id\s*:|HAL is a multi-disciplinary open access/iu, 'HAL'],
  [/See discussions, stats, and author profiles for this publication/iu, 'ResearchGate'],
  [/JSTOR is a not-for-profit service|Your use of the JSTOR archive/iu, 'JSTOR'],
  [/Full Terms & Conditions of access and use can be found at/iu, 'Taylor & Francis']
]

/** Each alone also appears in ordinary papers; two or more together mark a cover sheet. */
const COVER_SIGNALS: readonly RegExp[] = [
  /Citation for (?:the )?published version/iu,
  /\bGeneral rights\b/iu,
  /Take ?down policy/iu,
  /Copyright and (?:re-?use|moral rights)/iu,
  /Permanent (?:repository )?link/iu,
  /Link to (?:the )?published version/iu,
  /Document Version\s*:?/iu,
  /Download date\s*:/iu,
  /Link to publication(?: record)? (?:in|from)/iu,
  /Please cite this article as\s*:?/iu,
  /\bTo cite this (?:article|item|version)\s*:?/iu,
  /\bTo link to this article\s*:?/iu,
  /This version (?:of the publication )?(?:is available|may differ)/iu,
  /institutional repository/iu,
  /\bAccepted Manuscript\b[\s\S]{0,300}\bPII\s*:/iu,
  /\bReuse\b[\s\S]{0,600}\bTakedown\b/iu
]

/**
 * Recognises a cover sheet from the text of page 1. Only the first page of a multi-page PDF is
 * considered, and the user still decides whether it is dropped.
 */
export function detectRepositoryCoverPage(firstPageText: string, pageCount: number): CoverPageFinding | null {
  if (pageCount < 2) return null
  const text = firstPageText.replace(/\s+/gu, ' ').slice(0, 12_000)
  if (!text.trim()) return null
  const named = NAMED_COVERS.find(([pattern]) => pattern.test(text))
  if (named) return { source: named[1] }
  const signals = COVER_SIGNALS.filter((pattern) => pattern.test(text)).length
  return signals >= 2 ? { source: null } : null
}
