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
    expect(alignedBlocks).toHaveLength(blocks.length)
    expect(meaningfulMappings.filter((mapping) => alignedMappingIds.has(mapping.id))).toHaveLength(meaningfulMappings.length)
  })
})
