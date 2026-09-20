import { describe, expect, it } from 'vitest'
import type { BlockMapping } from '@shared/types'
import { DEFAULT_CHUNK_HARD_MAX_TOKENS, estimateTokens, structureAwareChunk, STRUCTURE_AWARE_CHUNKER_FINGERPRINT } from '../src/utility/core/compute/structureAwareChunker'

function mapping(id: string, order: number, sourceText: string, type = 'text'): BlockMapping {
  return { id, order, sourceText, type, boxes: [{ pageIndex: order, pageSize: [612, 792], bbox: [1, 2, 3, 4], blockPosition: `p-${order}` }] }
}

describe('structure-aware chunker', () => {
  it('is deterministic, preserves UTF-16 offsets, sections, types, and page provenance', () => {
    const source = '# 方法 Introduction\n\n这是正文😀，包含公式 $x^2$。\n\n```ts\nconst value = 1\n```\n\n| A | B |\n| - | - |\n| 1 | 2 |'
    const mappings = [
      mapping('heading', 0, '方法 Introduction', 'title'),
      mapping('body', 1, '这是正文，包含公式 x^2。'),
      mapping('code', 2, 'const value = 1', 'code'),
      mapping('table', 3, 'A B 1 2', 'table')
    ]
    const input = { documentId: 'doc', contentRevisionId: 'revision', contentHash: 'markdown-hash', sourceText: source, mappings }
    const first = structureAwareChunk(input)
    const second = structureAwareChunk(input)
    expect(first).toEqual(second)
    expect(first.map((chunk) => chunk.chunkId)).toEqual([...first].sort((a, b) => a.ordinal - b.ordinal).map((chunk) => chunk.chunkId))
    expect(first.some((chunk) => chunk.contentType === 'heading' && chunk.sectionPath[0] === '方法 Introduction')).toBe(true)
    expect(first.some((chunk) => chunk.contentType === 'code')).toBe(true)
    expect(first.some((chunk) => chunk.contentType === 'table' && chunk.pageStart === 3)).toBe(true)
    for (const chunk of first) {
      expect(chunk.offsetUnit).toBe('utf16')
      expect(chunk.sourceStartOffset).not.toBeNull()
      expect(chunk.sourceEndOffset).not.toBeNull()
      expect(source.slice(chunk.sourceStartOffset!, chunk.sourceEndOffset!)).toBeTruthy()
      expect([...chunk.sourceText].join('')).toBe(chunk.sourceText) // Array.from never splits a surrogate pair
      if (chunk.contentType !== 'table') expect(source.slice(chunk.sourceStartOffset!, chunk.sourceEndOffset!)).toBe(chunk.sourceText)
    }
    expect(STRUCTURE_AWARE_CHUNKER_FINGERPRINT).toContain('utf16')
  })

  it('splits only an overlong leaf at safe code-point boundaries and retains table headers', () => {
    const long = Array.from({ length: 2_000 }, (_, index) => `词${index}😀`).join(' ')
    const source = `# Results\n\n${long}\n\n| Name | Value |\n| --- | --- |\n${Array.from({ length: 500 }, (_, index) => `| row ${index} | value ${index} |`).join('\n')}`
    const chunks = structureAwareChunk({ documentId: 'doc', contentRevisionId: 'rev', contentHash: 'h', sourceText: source, mappings: [] })
    const leaves = chunks.filter((chunk) => chunk.contentType === 'paragraph')
    expect(leaves.length).toBeGreaterThan(1)
    expect(Math.max(...chunks.map((chunk) => chunk.tokenCount))).toBeLessThanOrEqual(700)
    const tableChunks = chunks.filter((chunk) => chunk.contentType === 'table')
    expect(tableChunks.every((chunk) => chunk.sourceText.includes('Name'))).toBe(true)
    // Repeated headers are synthetic text; their citation span intentionally
    // covers the original table, never claims a precise generated-row offset.
    expect(tableChunks.every((chunk) => source.slice(chunk.sourceStartOffset!, chunk.sourceEndOffset!).includes('| Name |'))).toBe(true)
    expect(estimateTokens('😀😀中文')).toBe(4)
  })

  it('bounds wide tables and oversized cells with deterministic column groups', () => {
    const longCell = Array.from({ length: 1_800 }, (_, index) => `cell${index}😀`).join(' ')
    const source = [
      '| 指标 | Description | Notes |',
      '| --- | --- | --- |',
      `| 1 | ${longCell} | stable |`
    ].join('\n')
    const chunks = structureAwareChunk({ documentId: 'doc', contentRevisionId: 'rev', contentHash: 'h', sourceText: source })
    const tables = chunks.filter((chunk) => chunk.contentType === 'table')
    expect(tables.length).toBeGreaterThan(1)
    expect(tables.every((chunk) => chunk.tokenCount <= DEFAULT_CHUNK_HARD_MAX_TOKENS)).toBe(true)
    expect(tables.every((chunk) => chunk.sourceText.includes('Table columns:') && chunk.sourceText.includes('Row:'))).toBe(true)
    expect(tables.every((chunk) => /指标|Description|Notes/u.test(chunk.sourceText))).toBe(true)
    const descriptionChunks = tables.filter((chunk) => chunk.sourceText.includes('Description'))
    expect(descriptionChunks.length).toBeGreaterThan(1)
    expect(descriptionChunks.every((chunk) => chunk.tokenCount > 32)).toBe(true)
    expect(descriptionChunks.every((chunk) => /^Table columns: Description\nRow: cell\d+😀/u.test(chunk.sourceText))).toBe(true)

    const longHeader = Array.from({ length: 3_000 }, () => 'H').join('')
    const headerChunks = structureAwareChunk({
      documentId: 'doc', contentRevisionId: 'rev-headers', contentHash: 'h',
      sourceText: `| ${longHeader} | Value |\n| --- | --- |\n| x | y |`
    }).filter((chunk) => chunk.contentType === 'table')
    expect(headerChunks.length).toBeGreaterThan(1)
    expect(headerChunks.every((chunk) => chunk.tokenCount <= DEFAULT_CHUNK_HARD_MAX_TOKENS)).toBe(true)
    expect(headerChunks.every((chunk) => chunk.sourceText.includes('Table columns:') && chunk.sourceText.includes('Row:'))).toBe(true)
    expect(headerChunks.every((chunk) => chunk.sourceText.includes('header fragment'))).toBe(true)
  })

  it('keeps empty input empty and long paragraph spans lossless, contiguous, and non-overlapping', () => {
    expect(structureAwareChunk({ documentId: 'doc', contentRevisionId: 'empty', contentHash: 'h', sourceText: '' })).toEqual([])
    const paragraph = Array.from({ length: 1_200 }, (_, index) => `word${index}😀`).join(' ')
    const source = `Inline formula $x^2$ remains in this paragraph.\n\n${paragraph}`
    const chunks = structureAwareChunk({ documentId: 'doc', contentRevisionId: 'rev-long', contentHash: 'h', sourceText: source })
    const paragraphChunks = chunks.filter((chunk) => chunk.contentType === 'paragraph')
    expect(chunks.some((chunk) => chunk.contentType === 'paragraph' && chunk.sourceText.includes('$x^2$'))).toBe(true)
    expect(paragraphChunks.length).toBeGreaterThan(1)
    expect(paragraphChunks.every((chunk) => chunk.tokenCount <= DEFAULT_CHUNK_HARD_MAX_TOKENS)).toBe(true)
    expect(paragraphChunks.slice(1).every((chunk, index) => chunk.sourceStartOffset! >= paragraphChunks[index]!.sourceEndOffset!)).toBe(true)
    const longChunks = paragraphChunks.filter((chunk) => chunk.sourceText.includes('word'))
    expect(longChunks.map((chunk) => chunk.sourceText).join('')).toBe(paragraph)
  })

  it('keeps missing mappings searchable with explicit none confidence and treats HTML as text', () => {
    const source = '<script>alert(1)</script>\n\n## Empty?\n\nVisible text'
    const chunks = structureAwareChunk({ documentId: 'doc', contentRevisionId: 'rev', contentHash: 'h', sourceText: source })
    expect(chunks.some((chunk) => chunk.mappingConfidence === 'none')).toBe(true)
    expect(chunks.some((chunk) => chunk.sourceText.includes('alert(1)'))).toBe(true)
    expect(chunks.every((chunk) => chunk.mappingIds.length === 0)).toBe(true)
  })

  it('covers nested structure, formulas, captions, footnotes, duplicate text, and multi-box provenance', () => {
    const source = [
      '# Introduction', '', '## 方法 Methods', '', '- outer', '  - nested', '    1. deep', '',
      'Repeated text. Repeated text.', '', 'Inline formula $a+b$ and a caption.', '',
      '$$', 'E = mc^2', '$$', '', 'Table 1: caption', '', '| A | B |', '|---|---|', '| 1 | 2 |', '', '[^1]: footnote text', '', '<script>bad()</script>'
    ].join('\n')
    const body = mapping('body', 0, 'Repeated text Repeated text', 'text')
    body.boxes.push({ pageIndex: 1, pageSize: [612, 792], bbox: [4, 5, 6, 7], blockPosition: 'continued', mergeRole: 'continuation' })
    const chunks = structureAwareChunk({ documentId: 'doc', contentRevisionId: 'rev', contentHash: 'hash', sourceText: source, mappings: [body] })
    expect(chunks.some((chunk) => chunk.contentType === 'heading' && chunk.sectionPath.join('/') === 'Introduction')).toBe(true)
    expect(chunks.some((chunk) => chunk.contentType === 'heading' && chunk.sectionPath.join('/') === 'Introduction/方法 Methods')).toBe(true)
    expect(chunks.some((chunk) => chunk.contentType === 'list')).toBe(true)
    expect(chunks.some((chunk) => chunk.contentType === 'formula')).toBe(true)
    expect(chunks.some((chunk) => chunk.contentType === 'caption')).toBe(true)
    expect(chunks.some((chunk) => chunk.sourceText.includes('footnote text'))).toBe(true)
    const bodyChunk = chunks.find((chunk) => chunk.mappingIds.includes('body'))
    expect(bodyChunk?.pageStart).toBe(0)
    expect(bodyChunk?.pageEnd).toBe(1)
    expect(bodyChunk?.mappingConfidence).toBe('range')
    const bodyMapping = [body].find((mapping) => mapping.id === bodyChunk?.mappingIds[0])
    expect(bodyMapping?.boxes.map((box) => ({ page: box.pageIndex, bbox: box.bbox }))).toEqual([
      { page: 0, bbox: [1, 2, 3, 4] }, { page: 1, bbox: [4, 5, 6, 7] }
    ])
    expect(chunks.filter((chunk) => chunk.sectionPath.join('/') === 'Introduction/方法 Methods').every((chunk) => chunk.sectionPath.includes('方法 Methods'))).toBe(true)
    expect(chunks.every((chunk, index) => chunk.ordinal === index)).toBe(true)
  })
})
