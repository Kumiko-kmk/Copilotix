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
      fallbackLegendText: 'DNS FNO F-FNO',
      status: 'complete',
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
    expect(buildReaderFigureGroups(blocks, stacked).filter(group => group.status === 'complete')).toEqual([])
    expect(buildReaderFigureGroups(blocks, stacked.filter((item) => item.id !== 'legend')).filter(group => group.status === 'complete')).toEqual([])
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
    expect(buildReaderFigureGroups(blocks, mappings).filter(group => group.status === 'complete')).toEqual([])
  })

  it('includes all six panels even when the caption order precedes the last two', () => {
    const assets = Array.from({ length: 6 }, (_, i) => mapping('panel-' + i, i < 4 ? i : i + 1,
      i % 2 ? 'image' : 'chart', [50 + i * 80, 100, 125 + i * 80, 200], i + '.jpg'))
    const caption = mapping('caption', 4, 'image_caption', [50, 210, 550, 240], undefined, 'Figure 19. Six panels.')
    const group = buildReaderFigureGeometries([...assets, caption])[0]!
    expect(group.status).toBe('complete')
    expect(group.assetSources).toHaveLength(6)
    expect(group.cropBox).toEqual([46, 96, 529, 204])
    expect(buildReaderFigureGeometries([caption, ...assets].reverse())).toEqual([group])
  })

  it('combines seven biological rows and their right-hand plots as one figure', () => {
    const maps = Array.from({ length: 7 }, (_, i) => [
      mapping('micro-' + i, i * 3, 'image_body', [60, 60 + i * 80, 440, 125 + i * 80], 'micro-' + i + '.jpg'),
      mapping('plot-' + i, i * 3 + 1, 'chart_body', [450, 60 + i * 80, 550, 125 + i * 80], 'plot-' + i + '.jpg'),
      mapping('label-' + i, i * 3 + 2, 'image_caption', [45, 60 + i * 80, 55, 75 + i * 80], undefined, String.fromCharCode(65 + i))
    ]).flat()
    maps.push(mapping('legend', 22, 'image_footnote', [450, 620, 550, 644], undefined, 'Ctrl; LPS; Gel'))
    maps.push(mapping('caption', 23, 'image_caption', [45, 655, 550, 700], undefined, 'Supplementary Figure S2: Biology.'))
    const [group] = buildReaderFigureGeometries(maps)
    expect(group?.status).toBe('complete')
    expect(group?.assetSources).toHaveLength(14)
    expect(group?.cropBox).toEqual([41, 56, 554, 648])
    expect(group?.mappingIds).toContain('label-6')
  })

  it.each([
    ['above', [60, 60, 550, 90]],
    ['side', [380, 100, 550, 230]]
  ] as const)('accepts a caption %s the panels', (_name, captionBox) => {
    const maps = [
      mapping('a', 10, 'image', [60, 100, 200, 230], 'a.jpg'),
      mapping('b', 11, 'chart', [210, 100, 350, 230], 'b.jpg'),
      mapping('caption', 1, 'image_caption', [...captionBox], undefined, 'Extended Data Fig. 3: Compare.')
    ]
    expect(buildReaderFigureGeometries(maps)[0]?.status).toBe('complete')
    expect(buildReaderFigureGeometries(maps)[0]?.assetSources).toHaveLength(2)
  })

  it('does not assign a connected component to competing captions', () => {
    const maps = [
      mapping('a', 1, 'chart', [100, 100, 240, 200], 'a.jpg'),
      mapping('b', 2, 'chart', [250, 100, 390, 200], 'b.jpg'),
      mapping('c1', 3, 'chart_caption', [100, 210, 240, 240], undefined, 'Figure 1: First.'),
      mapping('c2', 4, 'image_caption', [250, 210, 390, 240], undefined, 'Figure 2: Second.')
    ]
    const groups = buildReaderFigureGeometries(maps)
    expect(groups).toHaveLength(2)
    expect(groups.every(group => group.status === 'ambiguous')).toBe(true)
  })

  it('keeps two independent columns separate', () => {
    const maps = [
      mapping('a', 1, 'chart', [40, 100, 250, 200], 'a.jpg'),
      mapping('b', 2, 'image', [340, 100, 560, 200], 'b.jpg'),
      mapping('c1', 3, 'chart_caption', [40, 210, 250, 240], undefined, 'Figure 1: Left.'),
      mapping('c2', 4, 'image_caption', [340, 210, 560, 240], undefined, 'Figure 2: Right.')
    ]
    expect(buildReaderFigureGeometries(maps).map(group => [group.status, group.assetSources])).toEqual([
      ['complete', ['a.jpg']], ['complete', ['b.jpg']]
    ])
  })

  it('treats a short body paragraph inside a prospective crop as a barrier', () => {
    const maps = [
      mapping('a', 1, 'image', [50, 100, 240, 200], 'a.jpg'),
      mapping('b', 2, 'image', [250, 100, 550, 200], 'b.jpg'),
      mapping('paragraph', 3, 'text', [60, 150, 540, 180], undefined, 'Short body paragraph.'),
      mapping('caption', 4, 'chart_caption', [50, 210, 550, 240], undefined, 'Figure 1: Uncertain.')
    ]
    expect(buildReaderFigureGeometries(maps).filter(group => group.status === 'complete')).toEqual([])
  })

  it('does not silently omit a neighboring visual with an unknown asset', () => {
    const maps = [
      mapping('a', 1, 'chart', [50, 100, 200, 200], 'a.jpg'),
      mapping('unknown', 2, 'image', [210, 100, 350, 200]),
      mapping('caption', 3, 'image_caption', [50, 210, 350, 240], undefined, '图 4：完整图。')
    ]
    expect(buildReaderFigureGeometries(maps)[0]?.status).toBe('ambiguous')
  })

  it('uses valid continuation boxes and does not replace cross-page mappings', () => {
    const a = mapping('a', 1, 'image', [50, 100, 200, 200], 'a.jpg')
    a.boxes[0]!.isDiscarded = true
    a.boxes.push({ ...a.boxes[0]!, pageIndex: 12, isDiscarded: false })
    const caption = mapping('caption', 2, 'image_caption', [50, 210, 200, 240], undefined, 'Figure 1: One.')
    caption.boxes[0]!.pageIndex = 12
    expect(buildReaderFigureGeometries([a, caption])[0]?.pageIndex).toBe(12)
    a.boxes[0]!.isDiscarded = false
    expect(buildReaderFigureGeometries([a, caption]).some(group => group.status === 'complete')).toBe(false)
  })

  it('treats multiple caption boxes as one complete caption rather than competing figures', () => {
    const asset = mapping('a', 1, 'image', [50, 100, 350, 200], 'a.jpg')
    const caption = mapping('caption', 2, 'image_caption', [50, 210, 350, 230], undefined, 'Figure 1: First paragraph. Second paragraph.')
    caption.boxes.push({ ...caption.boxes[0]!, bbox: [50, 235, 350, 260], blockPosition: '11-second' })
    expect(buildReaderFigureGeometries([asset, caption])).toEqual([expect.objectContaining({
      status: 'complete', mappingIds: ['a', 'caption'], cropBox: [46, 96, 354, 204]
    })])
  })

  it('ignores malformed coordinates and preserves source blocks without inventing a crop', () => {
    const a = mapping('a', 1, 'image', [50, 100, 40, 200], 'a.jpg')
    expect(buildReaderFigureGeometries([a], '{bad-json')).toEqual([])
  })

  it('preserves the whole source when another panel has damaged coordinates', () => {
    const maps = [
      mapping('a', 1, 'image', [50, 100, 200, 200], 'a.jpg'),
      mapping('b', 2, 'chart', [210, 100, 200, 200], 'b.jpg'),
      mapping('caption', 3, 'image_caption', [50, 210, 350, 240], undefined, 'Figure 1: Both.')
    ]
    expect(buildReaderFigureGeometries(maps).filter(group => group.status === 'complete')).toEqual([])
    maps[1]!.boxes.push({ ...maps[1]!.boxes[0]!, bbox: [210, 100, 350, 200] })
    expect(buildReaderFigureGeometries(maps)[0]?.status).toBe('complete')
  })

  it('does not classify narrow body prose beside a panel as a graphical legend', () => {
    const maps = [
      mapping('a', 1, 'image', [50, 100, 200, 200], 'a.jpg'),
      mapping('prose', 2, 'text', [210, 100, 350, 200], undefined, 'The treatment reduced inflammation.'),
      mapping('caption', 3, 'image_caption', [50, 210, 350, 240], undefined, 'Figure 1: Treatment.')
    ]
    const group = buildReaderFigureGeometries(maps)[0]!
    expect(group.mappingIds).not.toContain('prose')
    expect(group.cropBox[2]).toBeLessThan(210)
  })

  it('recovers a missing panel from an explicit parser parent without changing mapping IDs', () => {
    const a = mapping('a', 1, 'image', [50, 100, 200, 200], 'a.jpg')
    const caption = mapping('caption', 2, 'image_caption', [50, 210, 550, 240], undefined, 'Figure 1: Whole.')
    const layout = JSON.stringify({ pdf_info: [{ page_idx: 11, page_size: [612, 792], para_blocks: [{
      type: 'image', blocks: [
        { type: 'image_body', bbox: [50, 100, 200, 200], lines: [{ spans: [{ image_path: 'a.jpg' }] }] },
        { type: 'chart_body', bbox: [400, 100, 550, 200], lines: [{ spans: [{ image_path: 'b.jpg' }] }] },
        { type: 'image_footnote', bbox: [400, 202, 550, 220], text: '20 μm' },
        { type: 'image_caption', text: 'Figure 1: Whole.' }
      ]
    }] }] })
    caption.boxes[0]!.bbox = [50, 230, 550, 260]
    const [group] = buildReaderFigureGeometries([a, caption], layout)
    expect(group?.status).toBe('complete')
    expect(group?.assetSources).toEqual(['a.jpg', 'b.jpg'])
    expect(group?.mappingIds).toEqual(['a', 'caption'])
    expect(group?.cropBox).toEqual([46, 96, 554, 224])
    expect(group?.members.some(member => member.sourceText === '20 μm' && !member.mappingId)).toBe(true)
    expect(group?.members.find(member => member.sourceAsset === 'b.jpg')?.mappingId).toBeUndefined()
  })

  it('accepts caption-free parser compound bodies but not isolated uncaptioned images', () => {
    const maps = [mapping('a', 1, 'image', [50, 100, 200, 200], 'a.jpg')]
    expect(buildReaderFigureGeometries(maps)[0]?.status).toBe('unsupported')
    const layout = JSON.stringify({ pdf_info: [{ page_idx: 11, page_size: [612, 792], para_blocks: [{
      type: 'image', blocks: [
        { type: 'image_body', bbox: [50, 100, 200, 200], lines: [{ spans: [{ image_path: 'a.jpg' }] }] },
        { type: 'image_body', bbox: [400, 400, 550, 500], lines: [{ spans: [{ image_path: 'b.jpg' }] }] }
      ]
    }] }] })
    expect(buildReaderFigureGeometries(maps, layout)[0]?.status).toBe('complete')
  })

  it('preserves multiline captions and does not match an asset name mentioned in prose', () => {
    const maps = [
      mapping('a', 1, 'image', [50, 100, 200, 200], 'a.jpg'),
      mapping('caption', 2, 'image_caption', [50, 210, 400, 260], undefined, 'Figure 1: First sentence. Second paragraph.')
    ]
    const geometry = buildReaderFigureGeometries(maps)
    const blocks = [
      block('prose', [], 'The filename a.jpg is mentioned here.'),
      block('image', ['a'], '![](images/a.jpg)'),
      block('caption', ['caption'], '图 1：第一段。\n\n完整的第二段。')
    ]
    const [group] = projectReaderFigureGroups(geometry, blocks)
    expect(group?.memberBlockIndexes).toEqual([1, 2])
    expect(group?.captionMarkdown).toBe('图 1：第一段。\n\n完整的第二段。')
  })

  it('projects translated graphical text by unchanged Markdown structure and preserves uncertain translations', () => {
    const maps = [
      mapping('a', 1, 'image', [50, 100, 200, 200], 'a.jpg'),
      mapping('legend', 2, 'image_footnote', [210, 100, 310, 180], undefined, 'Control; Treatment'),
      mapping('caption', 3, 'image_caption', [50, 210, 350, 240], undefined, 'Figure 1: Treatment.')
    ]
    const geometry = buildReaderFigureGeometries(maps)
    const original = [block('content:0', ['a', 'legend'], 'Body stays.\n\n![](a.jpg)  \nControl; Treatment'),
      block('content:1', ['caption'], 'Figure 1: Treatment.')]
    const translated = [block('content:0', ['a', 'legend'], '保留正文。\n\n![](a.jpg)  \n对照组；治疗组'),
      block('content:1', ['caption'], '图 1：治疗。')]
    const [group] = projectReaderFigureGroups(geometry, translated, original)
    expect(group?.status).toBe('complete')
    expect(group?.supportingTextsByBlock?.[0]).toContain('对照组；治疗组')
    expect(group?.supportingTextsByBlock?.[0]).not.toContain('保留正文。')
    translated[0]!.markdown = '保留正文。\n\n新增正文。\n\n![](a.jpg)  \n对照组；治疗组'
    expect(projectReaderFigureGroups(geometry, translated, original)[0]?.status).toBe('ambiguous')
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
