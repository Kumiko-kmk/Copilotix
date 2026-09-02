import { describe, expect, it } from 'vitest'
import type { BlockMapping } from '@shared/types'
import { extractPaperTitle, MAX_TITLE_STEM_LENGTH, sanitizeTitleStem, titleFileName } from '@main/titleNaming'

function mapping(
  sourceText: string,
  order: number,
  options: { type?: string; discarded?: boolean } = {}
): BlockMapping {
  return {
    id: `mapping-${order}`,
    order,
    type: options.type ?? 'title',
    sourceText,
    boxes: [{
      pageIndex: 0,
      pageSize: [612, 792],
      bbox: [0, 0, 100, 20],
      blockPosition: `0-${order}`,
      isDiscarded: options.discarded
    }]
  }
}

describe('paper title naming', () => {
  it('prefers the earliest non-discarded title mapping', () => {
    expect(extractPaperTitle('# Fallback Heading', [
      mapping('Later title', 4),
      mapping('Discarded title', 0, { discarded: true }),
      mapping('First title', 2)
    ])).toBe('First title')
  })

  it('falls back to the first useful Markdown heading and strips markup', () => {
    expect(extractPaperTitle('## **Attention** [Is All You Need](https://example.test)\n\n# Later heading\n', [])).toBe('Attention Is All You Need')
    expect(extractPaperTitle('# Some_Title\n', [])).toBe('Some_Title')
    expect(extractPaperTitle('Attention Is All You Need\n=========================\n', [])).toBe('Attention Is All You Need')
  })

  it('sanitizes Windows path characters and trailing whitespace', () => {
    expect(sanitizeTitleStem('A:B/C?D*E|F<>G. ')).toBe('A_B_C_D_E_F__G')
    expect(titleFileName('A:B/C')).toBe('A_B_C.pdf')
  })

  it('avoids Windows reserved names and enforces a bounded length', () => {
    expect(sanitizeTitleStem('CON')).toBe('_CON')
    expect(sanitizeTitleStem('CON.pdf')).toBe('_CON')
    expect(sanitizeTitleStem('LPT9')).toBe('_LPT9')
    expect(Array.from(sanitizeTitleStem('x'.repeat(MAX_TITLE_STEM_LENGTH + 20)) ?? '')).toHaveLength(MAX_TITLE_STEM_LENGTH)
  })

  it('returns null for empty or unusable titles', () => {
    expect(extractPaperTitle('No heading here', [])).toBeNull()
    expect(sanitizeTitleStem('...   ')).toBeNull()
  })

  it('is idempotent for an already-safe title', () => {
    const first = sanitizeTitleStem('Attention Is All You Need')
    expect(sanitizeTitleStem(first ?? '')).toBe(first)
    expect(titleFileName(first ?? '')).toBe('Attention Is All You Need.pdf')
  })
})
