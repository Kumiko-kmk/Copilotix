import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildBlockMappings } from '@main/blockMapping'
import { alignMarkdownBlocks } from '@shared/markdownBlocks'
import type { BlockMapping } from '@shared/types'

function mapping(id: string, order: number, sourceText: string, type = 'text'): BlockMapping {
  return {
    id,
    order,
    sourceText,
    type,
    boxes: [{ pageIndex: 0, pageSize: [612, 792], bbox: [10, 10 + order * 30, 300, 30 + order * 30], blockPosition: `0-${order}` }]
  }
}

describe('Markdown block alignment', () => {
  it('maps Markdown by canonical content instead of array index', () => {
    const mappings = [
      mapping('discarded', 0, 'Header', 'page_header'),
      mapping('title', 1, 'Document title', 'title'),
      mapping('paragraph', 2, 'Actual paragraph')
    ]
    mappings[0]!.boxes[0]!.isDiscarded = true
    const blocks = alignMarkdownBlocks('# Document title\n\nActual paragraph', mappings)
    expect(blocks.map((block) => block.mappingIds)).toEqual([['title'], ['paragraph']])
  })

  it('maps one Markdown node to every physical block it spans', () => {
    const blocks = alignMarkdownBlocks(
      'First reference\nSecond reference',
      [mapping('reference-1', 0, 'First reference'), mapping('reference-2', 1, 'Second reference')]
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.mappingIds).toEqual(['reference-1', 'reference-2'])
  })

  it('uses media order only for media-only Markdown blocks', () => {
    const blocks = alignMarkdownBlocks('![](images/chart.png)', [mapping('chart', 0, '', 'chart')])
    expect(blocks[0]?.mappingIds).toEqual(['chart'])
  })

  it('maps repeated short phrases only to their exact forward mappings', () => {
    const blocks = alignMarkdownBlocks(
      [
        'The abstract explains what happens then and furthermore motivates the method.',
        'Keywords: operators',
        'Then',
        'First equation explanation.',
        'Furthermore,',
        'Second equation explanation.',
        'Furthermore,'
      ].join('\n\n'),
      [
        mapping('abstract', 0, 'The abstract explains what happens then and furthermore motivates the method.'),
        mapping('keywords', 1, 'Keywords: operators'),
        mapping('then', 2, 'Then'),
        mapping('equation-1', 3, 'First equation explanation.'),
        mapping('furthermore-1', 4, 'Furthermore,'),
        mapping('equation-2', 5, 'Second equation explanation.'),
        mapping('furthermore-2', 6, 'Furthermore,')
      ]
    )

    expect(blocks.map((block) => block.mappingIds)).toEqual([
      ['abstract'],
      ['keywords'],
      ['then'],
      ['equation-1'],
      ['furthermore-1'],
      ['equation-2'],
      ['furthermore-2']
    ])
    const ids = blocks.flatMap((block) => block.mappingIds)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('leaves an uncertain block unlinked instead of reusing an earlier mapping', () => {
    const blocks = alignMarkdownBlocks(
      'Stable anchor.\n\nUnrelated content with no layout counterpart.',
      [mapping('anchor', 0, 'Stable anchor.'), mapping('different', 1, 'Entirely different layout text.')]
    )

    expect(blocks.map((block) => block.mappingIds)).toEqual([['anchor'], []])
  })

  const acceptanceRoot = process.env.MINERU_LAYOUT_ACCEPTANCE_DIR
  it.skipIf(!acceptanceRoot)('aligns the local MinerU Markdown to layout content with high coverage', async () => {
    const layout = JSON.parse(await readFile(join(acceptanceRoot!, 'layout.json'), 'utf8'))
    const markdown = await readFile(join(acceptanceRoot!, 'full.md'), 'utf8')
    const mappings = buildBlockMappings('acceptance-task', layout)
    const blocks = alignMarkdownBlocks(markdown, mappings)
    const alignedBlocks = blocks.filter((block) => block.mappingIds.length > 0)
    const alignedMappingIds = new Set(alignedBlocks.flatMap((block) => block.mappingIds))
    const meaningfulMappings = mappings.filter((mapping) =>
      mapping.sourceText.length >= 16 && !mapping.boxes.every((box) => box.isDiscarded)
    )
    const assignedIds = blocks.flatMap((block) => block.mappingIds)
    expect(alignedBlocks.length / blocks.length).toBeGreaterThanOrEqual(0.99)
    expect(meaningfulMappings.filter((mapping) => alignedMappingIds.has(mapping.id)).length / meaningfulMappings.length)
      .toBeGreaterThanOrEqual(0.99)
    expect(new Set(assignedIds).size).toBe(assignedIds.length)
  })

  const regressionRoot = process.env.MINERU_READER_REGRESSION_DIR
  it.skipIf(!regressionRoot)('preserves the exact 97-page regression task alignment', async () => {
    const layout = JSON.parse(await readFile(join(regressionRoot!, 'layout.json'), 'utf8'))
    const markdown = await readFile(join(regressionRoot!, 'full.md'), 'utf8')
    const mappings = buildBlockMappings('reader-regression-task', layout)
    const blocks = alignMarkdownBlocks(markdown, mappings)
    const orderById = new Map(mappings.map((item) => [item.id, item.order]))
    const mappingOrders = (block: (typeof blocks)[number]) => block.mappingIds.map((id) => orderById.get(id))
    const thenBlocks = blocks.filter((block) => block.markdown.trim() === 'Then')
    const furthermoreBlocks = blocks.filter((block) => block.markdown.trim() === 'Furthermore,')
    const assignedIds = blocks.flatMap((block) => block.mappingIds)

    expect(blocks).toHaveLength(1110)
    expect(blocks.filter((block) => block.mappingIds.length > 0)).toHaveLength(1109)
    expect(new Set(assignedIds).size).toBe(assignedIds.length)
    expect(thenBlocks).toHaveLength(1)
    expect(mappingOrders(thenBlocks[0]!)).toEqual([1246])
    expect(furthermoreBlocks).toHaveLength(2)
    expect(furthermoreBlocks.map(mappingOrders)).toEqual([[1278], [1330]])
  })
})
