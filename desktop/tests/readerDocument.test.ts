import { describe, expect, it } from 'vitest'
import {
  buildOriginalReaderBlocks,
  buildReaderDocumentBlocks,
  buildTranslatedReaderBlocks,
  mergeReaderBlocks
} from '@shared/readerDocument'
import type { BlockMapping, TranslatedMarkdownBlock } from '@shared/types'

describe('reader document model', () => {
  it('restores headers, footnotes and page dividers while hiding printed page numbers', () => {
    const mappings = [
      mapping('header-1', 0, 'Journal header', 'page_header', 0, true),
      mapping('title', 1, 'Document title', 'title', 0),
      mapping('footnote-1', 2, 'Conference copyright notice', 'page_footnote', 0, true),
      mapping('number-1', 3, '315', 'page_number', 0, true),
      mapping('header-2', 4, 'Document running title', 'page_header', 1, true),
      mapping('body', 5, 'Body paragraph', 'text', 1),
      mapping('footer-2', 6, 'Author footer', 'page_footer', 1, true)
    ]
    const translatedBlocks: TranslatedMarkdownBlock[] = [
      { sourceIndex: 0, markdown: '# 文档标题', mappingIds: ['polluted-title'] },
      { sourceIndex: 1, markdown: '正文段落', mappingIds: ['polluted-body'] }
    ]

    const result = buildReaderDocumentBlocks(
      '# Document title\n\nBody paragraph',
      '# 文档标题\n\n正文段落',
      translatedBlocks,
      mappings
    )

    expect(result.original.map((block) => [block.role, block.text ?? block.markdown])).toEqual([
      ['page-header', 'Journal header'],
      ['content', '# Document title'],
      ['footnote', 'Conference copyright notice'],
      ['page-divider', '第 1 页'],
      ['page-header', 'Document running title'],
      ['content', 'Body paragraph'],
      ['page-footer', 'Author footer'],
      ['page-divider', '第 2 页']
    ])
    expect(result.translated.map((block) => [block.role, block.text ?? block.markdown])).toEqual([
      ['page-header', 'Journal header'],
      ['content', '# 文档标题'],
      ['footnote', 'Conference copyright notice'],
      ['page-divider', '第 1 页'],
      ['page-header', 'Document running title'],
      ['content', '正文段落'],
      ['page-footer', 'Author footer'],
      ['page-divider', '第 2 页']
    ])
    expect([...result.original, ...result.translated].some((block) => block.role === 'page-number')).toBe(false)
    expect(result.original.filter((block) => block.role === 'page-divider').map((block) => block.text))
      .toEqual(['第 1 页', '第 2 页'])
    expect(result.translated.filter((block) => block.role === 'page-divider').map((block) => block.text))
      .toEqual(['第 1 页', '第 2 页'])
    expect(result.original.filter((block) => block.role !== 'content').every((block) => block.mappingIds.length === 0))
      .toBe(true)
    expect(result.translated.filter((block) => block.role === 'content').map((block) => block.mappingIds))
      .toEqual([['title'], ['body']])
    expect(result.original.map((block) => block.annotationKey ?? null)).toEqual([
      'supplemental:header-1',
      'content:0',
      'supplemental:footnote-1',
      null,
      'supplemental:header-2',
      'content:1',
      'supplemental:footer-2',
      null
    ])
    expect(result.translated.filter((block) => block.role === 'content').map((block) => block.annotationKey))
      .toEqual(['content:0', 'content:1'])
    expect(buildOriginalReaderBlocks('# Document title\n\nBody paragraph', mappings)).toEqual(result.original)
    expect(buildTranslatedReaderBlocks(
      '# Document title\n\nBody paragraph',
      '# 文档标题\n\n正文段落',
      translatedBlocks,
      mappings
    )).toEqual(result.translated)
  })

  it('keeps malformed translated source indexes readable but unlinked', () => {
    const mappings = [
      mapping('title', 0, 'Document title', 'title', 0),
      mapping('body', 1, 'Body paragraph', 'text', 0)
    ]
    const result = buildReaderDocumentBlocks(
      '# Document title\n\nBody paragraph',
      '# 文档标题\n\n正文段落',
      [
        { sourceIndex: 0, markdown: '# 文档标题', mappingIds: ['title'] },
        { sourceIndex: 0, markdown: '正文段落', mappingIds: ['body'] }
      ],
      mappings
    )

    expect(result.translated.filter((block) => block.role === 'content').map((block) => block.mappingIds))
      .toEqual([[], []])
  })

  it('preserves content order and omits unknown discarded blocks', () => {
    const mappings = [
      mapping('header', 0, 'Header', 'page_header', 0, true),
      mapping('body', 2, 'Mapped body', 'text', 0),
      mapping('discarded', 3, 'Unclassified margin text', 'unknown', 0, true)
    ]
    const result = mergeReaderBlocks(
      [
        { markdown: 'Unmapped preface', mappingIds: [] },
        { markdown: 'Mapped body', mappingIds: ['body'] }
      ],
      mappings
    )

    expect(result.map((block) => block.role)).toEqual([
      'page-header',
      'content',
      'content',
      'page-divider'
    ])
    expect(result[1]?.markdown).toBe('Unmapped preface')
    expect(result.some((block) => block.text === 'Unclassified margin text')).toBe(false)
  })

  it('places each physical page divider after its last mapped Markdown block', () => {
    const mappings = [
      mapping('page-1-body', 0, 'First page body', 'text', 0),
      mapping('page-2-figure', 1, 'Figure 1 caption', 'image', 1),
      mapping('page-3-body', 2, 'Third page body', 'text', 2)
    ]
    const result = mergeReaderBlocks([
      { markdown: 'First page body', mappingIds: ['page-1-body'] },
      { markdown: '![figure](images/figure.png)\n\nFigure 1 caption', mappingIds: ['page-2-figure'] },
      { markdown: 'Third page body', mappingIds: ['page-3-body'] }
    ], mappings)

    expect(result.map((block) => block.text ?? block.markdown)).toEqual([
      'First page body',
      '第 1 页',
      '![figure](images/figure.png)\n\nFigure 1 caption',
      '第 2 页',
      'Third page body',
      '第 3 页'
    ])
  })

  it('never reorders source blocks even when their mappings are contaminated', () => {
    const mappings = [
      mapping('abstract', 0, 'Abstract paragraph', 'text', 0),
      mapping('then', 100, 'Then', 'text', 4),
      mapping('furthermore-1', 120, 'Furthermore,', 'text', 5),
      mapping('furthermore-2', 140, 'Furthermore,', 'text', 6)
    ]
    const source = [
      { markdown: 'Abstract paragraph', mappingIds: ['abstract'] },
      { markdown: 'Keywords', mappingIds: [] },
      { markdown: 'Then', mappingIds: ['then', 'abstract'] },
      { markdown: 'Furthermore,', mappingIds: ['furthermore-1', 'abstract'] },
      { markdown: 'Furthermore,', mappingIds: ['furthermore-2', 'abstract'] }
    ]

    const result = mergeReaderBlocks(source, mappings)
    expect(result.filter((block) => block.role === 'content').map((block) => block.markdown)).toEqual([
      'Abstract paragraph',
      'Keywords',
      'Then',
      'Furthermore,',
      'Furthermore,'
    ])
  })
})

function mapping(
  id: string,
  order: number,
  sourceText: string,
  type: string,
  pageIndex: number,
  isDiscarded = false
): BlockMapping {
  return {
    id,
    order,
    sourceText,
    type,
    boxes: [{
      pageIndex,
      bbox: [10, 10, 100, 30],
      pageSize: [612, 792],
      blockPosition: String(pageIndex) + '-' + String(order),
      isDiscarded
    }]
  }
}
