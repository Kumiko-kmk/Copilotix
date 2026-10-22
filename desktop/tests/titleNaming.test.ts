import { describe, expect, it } from 'vitest'
import type { BlockMapping } from '@shared/types'
import { displayPaperTitle, extractPaperTitle, MAX_TITLE_STEM_LENGTH, sanitizeTitleStem, titleFileName } from '@shared/titleNaming'
import { detectRepositoryCoverPage, trustedPdfMetadataTitle } from '@shared/pdfImport'

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

  it('keeps punctuation in display titles while making export filenames Windows-safe', () => {
    expect(displayPaperTitle('DeepONet: Learning nonlinear operators')).toBe('DeepONet: Learning nonlinear operators')
    expect(displayPaperTitle('Transolver: A Fast Transformer Solver for PDEs')).toBe('Transolver: A Fast Transformer Solver for PDEs')
    expect(displayPaperTitle('DeepONet: Learning nonlinear operators\0')).toBe('DeepONet: Learning nonlinear operators')
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

describe('PDF import preview', () => {
  it('uses a metadata title only when it reads like a paper title', () => {
    expect(trustedPdfMetadataTitle('Machine learning for computational fracture and damage mechanics— Status and perspectives', 'x.pdf'))
      .toBe('Machine learning for computational fracture and damage mechanics— Status and perspectives')
    expect(trustedPdfMetadataTitle('Mask R-CNN')).toBe('Mask R-CNN')
    expect(trustedPdfMetadataTitle('深度残差网络在图像识别中的应用')).toBe('深度残差网络在图像识别中的应用')
    for (const rejected of [
      'Microsoft Word - manuscript_v3.docx', 'paper_final_v2.pdf', 'Untitled', 'Accepted Manuscript', 'main',
      'JMPS-D-24-01234', 'doi:10.1016/j.jmps.2024.105555', 'Paper Title (use style: paper title)', 'Layout 1', '', null
    ]) expect(trustedPdfMetadataTitle(rejected)).toBeNull()
    expect(trustedPdfMetadataTitle('1-s2.0-S0013794425009798-main', '1-s2.0-S0013794425009798-main.pdf')).toBeNull()
  })

  it('flags repository cover sheets on page 1 of multi-page PDFs only', () => {
    const city = 'Copyright and Reuse: ... City Research Online: http://openaccess.city.ac.uk/ Citation: Ani, A. (2026). Permanent repository link: https://openaccess.city.ac.uk/id/eprint/36408/'
    expect(detectRepositoryCoverPage(city, 36)).toEqual({ source: 'City Research Online' })
    expect(detectRepositoryCoverPage(city, 1)).toBeNull()
    expect(detectRepositoryCoverPage('Citation for published version (APA): Smith. General rights Copyright ... Take down policy', 12)).toEqual({ source: null })
    expect(detectRepositoryCoverPage('Abstract. We study fracture. Please cite this article as the published version.', 12)).toBeNull()
  })
})
