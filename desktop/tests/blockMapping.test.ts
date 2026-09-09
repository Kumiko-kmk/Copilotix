import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BLOCK_MAPPING_VERSION, buildBlockMappings, stableBlockId } from '@core/blockMapping'

describe('block mapping', () => {
  it('uses the canonical v3 artifact format', () => {
    expect(BLOCK_MAPPING_VERSION).toBe(3)
  })

  it('builds deterministic ids from layout para blocks', () => {
    const layout = {
      pdf_info: [
        {
          page_idx: 0,
          page_size: [612, 792],
          para_blocks: [
            { type: 'title', index: 2, bbox: [10, 20, 200, 60], lines: [{ bbox: [10, 20, 200, 60], spans: [{ content: 'Title' }] }] },
            { type: 'text', index: 5, bbox: [10, 80, 500, 200], lines: [{ bbox: [10, 80, 500, 200], spans: [{ content: 'Paragraph' }] }] }
          ]
        }
      ]
    }
    const first = buildBlockMappings('task-1', layout)
    const second = buildBlockMappings('task-1', layout)
    expect(first).toEqual(second)
    expect(first).toHaveLength(2)
    expect(first[0]?.boxes[0]?.blockPosition).toBe('0-0')
    expect(first[0]?.sourceText).toBe('Title')
  })

  it('merges source boxes that share a logical id', () => {
    const blockList = {
      pdfData: [
        { blocks: [{ id: 'shared', page_idx: 0, page_size: [612, 792], block_position: '0-7', type: 'text', bbox: [10, 700, 500, 780] }] },
        { blocks: [{ id: 'shared', page_idx: 1, page_size: [612, 792], block_position: '1-0', type: 'text', bbox: [10, 10, 500, 100] }] }
      ]
    }
    const mappings = buildBlockMappings('task-2', blockList)
    expect(mappings).toHaveLength(1)
    expect(mappings[0]?.boxes).toHaveLength(2)
    expect(mappings[0]?.id).toBe(stableBlockId('task-2', ['0-7', '1-0']))
  })

  it('groups same-page and cross-page deleted geometry into logical paragraphs', () => {
    const layout = {
      pdf_info: [
        {
          page_idx: 0,
          page_size: [612, 792],
          para_blocks: [
            {
              type: 'text',
              bbox: [70, 600, 300, 650],
              lines: [
                { bbox: [70, 600, 300, 620], spans: [{ content: 'A paragraph' }] },
                { bbox: [330, 100, 560, 120], spans: [{ content: 'continues in another column' }] },
                { bbox: [80, 300, 300, 320], spans: [{ content: 'and on the next page' }] }
              ]
            },
            { type: 'text', bbox: [330, 90, 565, 140], lines: [], lines_deleted: true }
          ]
        },
        {
          page_idx: 1,
          page_size: [612, 792],
          para_blocks: [
            { type: 'text', bbox: [75, 290, 310, 330], lines: [], lines_deleted: true },
            { type: 'title', bbox: [70, 350, 200, 380], lines: [{ bbox: [70, 350, 200, 380], spans: [{ content: 'Next title' }] }] }
          ]
        }
      ]
    }
    const mappings = buildBlockMappings('merged-task', layout)
    expect(mappings).toHaveLength(2)
    expect(mappings[0]?.boxes.map((box) => box.blockPosition)).toEqual(['0-0', '0-1', '1-0'])
    expect(mappings[0]?.boxes.map((box) => box.mergeRole)).toEqual(['source', 'continuation', 'continuation'])
    expect(mappings[0]?.sourceText).toBe('A paragraph continues in another column and on the next page')
  })

  it('includes discarded page geometry without mixing it into content mappings', () => {
    const mappings = buildBlockMappings('discarded-task', {
      pdf_info: [{
        page_idx: 0,
        page_size: [612, 792],
        para_blocks: [{ type: 'text', bbox: [10, 20, 200, 60], lines: [{ bbox: [10, 20, 200, 60], spans: [{ content: 'Body' }] }] }],
        discarded_blocks: [{ type: 'page_number', bbox: [290, 760, 320, 780], lines: [{ bbox: [290, 760, 320, 780], spans: [{ content: '1' }] }] }]
      }]
    })
    expect(mappings).toHaveLength(2)
    expect(mappings[1]?.boxes[0]?.isDiscarded).toBe(true)
  })

  it.each(['hybrid', 'pipeline'])('normalizes nested %s text, media and finite geometry', (backend) => {
    const mappings = buildBlockMappings('nested-task', {
      _backend: backend,
      pdf_info: [{
        page_idx: 0,
        page_size: { width: 612, height: 792 },
        para_blocks: [
          {
            type: 'text',
            index: 1,
            bbox: [10, 20, 500, 80],
            lines: [{ bbox: [10, 20, 500, 80], spans: [{ content: 'Nested paragraph text' }] }]
          },
          {
            type: 'image',
            index: 2,
            bbox: [20, 100, 400, 300],
            blocks: [{
              type: 'image_body',
              bbox: [20, 100, 400, 260],
              lines: [{ bbox: [20, 100, 400, 260], spans: [{ image_path: 'images/figure.png' }] }]
            }]
          },
          { type: 'text', index: 3, bbox: [Number.NaN, 1, 2, 3], lines: [] }
        ]
      }]
    })

    expect(mappings).toHaveLength(2)
    expect(mappings[0]).toMatchObject({ type: 'text', sourceText: 'Nested paragraph text' })
    expect(mappings[1]).toMatchObject({ type: 'image', sourceAsset: 'images/figure.png' })
    expect(mappings.every((mapping) => mapping.boxes.every((box) => box.pageIndex === 0))).toBe(true)
  })

  const oracleRoot = process.env.COPILOTIX_LAYOUT_ORACLE_DIR
  it.skipIf(!oracleRoot)('reproduces the official merge connections for a local Copilotix result', async () => {
    const layout = JSON.parse(await readFile(join(oracleRoot!, 'layout.json'), 'utf8'))
    const official = JSON.parse(await readFile(join(oracleRoot!, 'block_list.json'), 'utf8')) as {
      mergeConnections: Array<{ blocks: string[] }>
      pdfData: Array<Array<{ block_position: string; bbox: [number, number, number, number]; page_idx: number; page_size: [number, number] }>>
    }
    const mappings = buildBlockMappings('oracle-task', layout)
    const actualGeometry = mappings.flatMap((mapping) => mapping.boxes).map((box) => ({
      position: box.blockPosition,
      bbox: box.bbox,
      pageIndex: box.pageIndex,
      pageSize: box.pageSize
    })).sort((left, right) => left.position.localeCompare(right.position, undefined, { numeric: true }))
    const expectedGeometry = official.pdfData.flatMap((page) => page).map((block) => ({
      position: block.block_position,
      bbox: block.bbox,
      pageIndex: block.page_idx,
      pageSize: block.page_size
    })).sort((left, right) => left.position.localeCompare(right.position, undefined, { numeric: true }))
    expect(actualGeometry).toEqual(expectedGeometry)
    const actual = mappings
      .filter((mapping) => mapping.boxes.length > 1)
      .map((mapping) => mapping.boxes.map((box) => box.blockPosition).join('|'))
      .sort()
    const expected = official.mergeConnections.map((connection) => connection.blocks.join('|')).sort()
    expect(actual).toEqual(expected)
  })
})
