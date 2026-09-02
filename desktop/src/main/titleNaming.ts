import type { BlockMapping } from '@shared/types'

/** Maximum stem length used for both the task name and its output directory. */
export const MAX_TITLE_STEM_LENGTH = 100

// NUL/control characters are intentionally stripped from user-derived filenames.
// eslint-disable-next-line no-control-regex
const INVALID_FILENAME_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f]/gu
const WINDOWS_RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu

/**
 * Finds the first usable title block and falls back to the first useful
 * Markdown heading. The function is deliberately deterministic and does not
 * call a translation model or any other external service.
 */
export function extractPaperTitle(markdown: string, mappings: readonly BlockMapping[]): string | null {
  const candidates = mappings
    .map((mapping, index) => ({ mapping, index }))
    .filter(({ mapping }) => {
      if (!mapping || typeof mapping !== 'object') return false
      if (isDiscardedMapping(mapping)) return false
      return typeof mapping.type === 'string' && mapping.type.trim().toLowerCase() === 'title' &&
        typeof mapping.sourceText === 'string' && Boolean(mapping.sourceText.trim())
    })
    .sort((left, right) => {
      const leftOrder = Number.isFinite(left.mapping.order) ? left.mapping.order : Number.MAX_SAFE_INTEGER
      const rightOrder = Number.isFinite(right.mapping.order) ? right.mapping.order : Number.MAX_SAFE_INTEGER
      const orderDelta = leftOrder - rightOrder
      return orderDelta || left.index - right.index
    })

  for (const { mapping } of candidates) {
    const title = cleanTitleText(mapping.sourceText)
    if (title) return title
  }

  return extractMarkdownHeading(markdown)
}

/** Removes presentation markup while retaining the human-readable title. */
export function cleanTitleText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\](?:\([^)]*\)|\[[^\]]*\])?/gu, '$1')
    .replace(/<[^>]*>/gu, ' ')
    .replace(/\s*\{#[^}]+\}\s*$/u, '')
    .replace(/\\([\\`*_{}\x5b\x5d()#+.!-])/gu, '$1')
    .replace(/\*\*([^*\r\n]+)\*\*/gu, '$1')
    .replace(/__([^_\r\n]+)__/gu, '$1')
    .replace(/~~([^~\r\n]+)~~/gu, '$1')
    .replace(/`([^`\r\n]+)`/gu, '$1')
    .replace(/(^|[\s([{])\*([^*\r\n]+)\*(?=$|[\s)\]}.,!?;:])/gu, '$1$2')
    .replace(/(^|[\s([{])_([^_\r\n]+)_(?=$|[\s)\]}.,!?;:])/gu, '$1$2')
    .replace(/^\s*#{1,6}\s+/u, '')
    .replace(/\s+#+\s*$/u, '')
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * Converts a parsed title into a Windows-safe filename stem. A null result
 * means that the parsed title is empty or otherwise unusable and callers
 * should keep the original filename.
 */
export function sanitizeTitleStem(value: string): string | null {
  let stem = value
    .normalize('NFKC')
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(INVALID_FILENAME_CHARACTERS, '_')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[. ]+$/gu, '')
    .trim()

  if (!stem || stem === '.' || stem === '..') return null
  if (/\.pdf$/iu.test(stem)) stem = stem.slice(0, -4).replace(/[. ]+$/gu, '').trim()
  if (!stem || stem === '.' || stem === '..') return null

  stem = Array.from(stem).slice(0, MAX_TITLE_STEM_LENGTH).join('')
    .replace(/[. ]+$/gu, '')
    .trim()
  if (!stem || stem === '.' || stem === '..') return null

  if (WINDOWS_RESERVED_NAME.test(stem)) stem = `_${stem}`
  return stem
}

export function titleFileName(value: string): string | null {
  const stem = sanitizeTitleStem(value)
  return stem ? `${stem}.pdf` : null
}

function extractMarkdownHeading(markdown: string): string | null {
  const lines = markdown.split(/\r?\n/u)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const atx = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u)
    if (atx) {
      const title = cleanTitleText(atx[1] ?? '')
      if (isUsefulHeading(title)) return title
    }

    const next = lines[index + 1] ?? ''
    if (line.trim() && /^\s*(?:=+|-+)\s*$/u.test(next)) {
      const title = cleanTitleText(line)
      if (isUsefulHeading(title)) return title
    }
  }
  return null
}

function isUsefulHeading(value: string): boolean {
  return Boolean(value)
}

function isDiscardedMapping(mapping: BlockMapping): boolean {
  if (!mapping || typeof mapping !== 'object') return true
  const candidate = mapping as BlockMapping & {
    isDiscarded?: unknown
    discarded?: unknown
    is_discarded?: unknown
  }
  if (candidate.isDiscarded === true || candidate.discarded === true || candidate.is_discarded === true) return true
  const boxes = Array.isArray(mapping.boxes) ? mapping.boxes : []
  return boxes.length > 0 && boxes.every((box) => box.isDiscarded === true)
}
