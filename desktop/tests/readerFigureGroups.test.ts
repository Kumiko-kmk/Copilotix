import { describe, expect, it } from 'vitest'
import type { ReaderBlock } from '../src/shared/readerDocument'
import type { BlockMapping } from '../src/shared/types'
import {
  buildReaderFigureGeometries,
  buildReaderFigureGroups,
  projectReaderFigureGroups
} from '../src/renderer/readerFigureGroups'

describe('reader figure groups', () => {
  it('projects adjacent charts and their graphical legend as one PDF region', () => {
    const mappings = [
      mapping('chart-a', 158, 'chart', [109, 518, 244, 618], 'a.jpg'),
      mapping('label-a', 159, 'chart_caption', [180, 624, 193, 635], undefined, '(a)'),
      mapping('chart-b', 160, 'chart', [246, 518, 387, 618], 'b.jpg'),
      mapping('label-b', 161, 'chart_caption', [321, 624, 334, 635], undefined, '(b)'),
      mapping('legend', 162, 'chart_footnote', [394, 544, 500, 582], undefined, 'DNS FNO F-FNO'),
      mapping('caption', 163, 'chart_caption', [104, 643, 506, 700], undefined, 'Figure A.1: Resource use.')
    ]
    const blocks = [
      block('content:119', ['label-a'], '![](images/a.jpg)  \n(a)'),
      block('content:120', ['label-b', 'legend', 'caption'], '![](images/b.jpg)  \n(b)  \nDNS FNO F-FNO  \n图 A.1：资源使用。')
    ]

    expect(buildReaderFigureGroups(blocks, mappings)).toEqual([expect.objectContaining({
      pageIndex: 11,
      cropBox: [105, 514, 504, 639],
      mappingIds: ['chart-a', 'label-a', 'chart-b', 'label-b', 'legend', 'caption'],
      assetSources: ['a.jpg', 'b.jpg'],
      ownerBlockIndex: 0,
      captionBlockIndex: 1,
      memberBlockIndexes: [0, 1],
      fallbackLegendMarkdown: 'DNS FNO F-FNO',
      captionMarkdown: '图 A.1：资源使用。'
    })])
  })

  it('does not combine vertically stacked or legend-free charts', () => {
    const stacked = [
      mapping('a', 1, 'chart', [100, 100, 300, 200], 'a.jpg'),
      mapping('b', 2, 'chart', [100, 220, 300, 320], 'b.jpg'),
      mapping('legend', 3, 'chart_footnote', [310, 100, 400, 180]),
      mapping('caption', 4, 'chart_caption', [100, 330, 400, 370], undefined, 'Long shared caption')
    ]
    const blocks = [
      block('content:1', ['a'], '![](a.jpg)'),
      block('content:2', ['b', 'caption'], '![](b.jpg)  \ncaption')
    ]
    expect(buildReaderFigureGroups(blocks, stacked)).toEqual([])
    expect(buildReaderFigureGroups(blocks, stacked.filter((item) => item.id !== 'legend'))).toEqual([])
  })

  it('anchors an interleaved figure by its caption and reuses the geometry for each language', () => {
    const mappings = [
      mapping('chart-a', 10, 'image', [80, 300, 260, 420], 'left.jpg'),
      mapping('label-a', 11, 'chart_caption', [160, 424, 180, 438], undefined, '(a)'),
      mapping('chart-b', 12, 'chart', [270, 304, 450, 455], 'right.jpg'),
      mapping('label-b', 13, 'chart_caption', [350, 458, 370, 472], undefined, '(b)'),
      mapping('legend', 14, 'text', [455, 330, 560, 410], undefined, 'solid: model A; dashed: model B'),
      mapping('caption', 15, 'chart_caption', [78, 480, 560, 515], undefined, 'Figure 4: Comparison.')
    ]
    const geometry = buildReaderFigureGeometries(mappings)
    expect(geometry).toEqual([expect.objectContaining({
      cropBox: [76, 296, 564, 476],
      assetSources: ['left.jpg', 'right.jpg'],
      captionMappingId: 'caption',
      fallbackLegendText: 'solid: model A; dashed: model B'
    })])

    const original = [
      block('content:1', ['chart-a', 'label-a'], '![](left.jpg)  \n(a)'),
      block('content:2', ['chart-b', 'label-b', 'legend'], '![](right.jpg)  \n(b)  \nsolid: model A; dashed: model B'),
      block('content:3', ['caption'], 'Figure 4: Comparison.')
    ]
    const translated = [
      block('content:1', ['chart-a', 'label-a'], '![](left.jpg)  \n（一）'),
      block('content:2', ['chart-b', 'label-b', 'legend'], '![](right.jpg)  \n（二）  \n实线：模型 A；虚线：模型 B'),
      block('content:3', ['caption'], '图 4：模型比较。')
    ]
    expect(projectReaderFigureGroups(geometry, original)[0]).toMatchObject({ captionMarkdown: 'Figure 4: Comparison.' })
    expect(projectReaderFigureGroups(geometry, translated)[0]).toMatchObject({ captionMarkdown: '图 4：模型比较。' })
  })

  it('stops at a table boundary instead of joining neighboring figures', () => {
    const mappings = [
      mapping('chart-a', 1, 'chart', [80, 100, 240, 220], 'a.jpg'),
      mapping('table', 2, 'table', [70, 225, 550, 300]),
      mapping('chart-b', 3, 'chart', [260, 100, 420, 220], 'b.jpg'),
      mapping('caption', 4, 'chart_caption', [70, 310, 550, 345], undefined, 'Figure 2: Separate content.')
    ]
    const blocks = [
      block('content:1', ['chart-a'], '![](a.jpg)'),
      block('content:2', ['chart-b'], '![](b.jpg)'),
      block('content:3', ['caption'], 'Figure 2: Separate content.')
    ]
    expect(buildReaderFigureGroups(blocks, mappings)).toEqual([])
  })
})

function mapping(
  id: string,
  order: number,
  type: string,
  bbox: [number, number, number, number],
  sourceAsset?: string,
  sourceText = ''
): BlockMapping {
  return {
    id,
    order,
    type,
    sourceText,
    ...(sourceAsset ? { sourceAsset } : {}),
    boxes: [{ pageIndex: 11, bbox, pageSize: [612, 792], blockPosition: `11-${order}`, isDiscarded: false }]
  }
}

function block(annotationKey: string, mappingIds: string[], markdown: string): ReaderBlock {
  return { role: 'content', annotationKey, mappingIds, markdown, order: 0 }
}
