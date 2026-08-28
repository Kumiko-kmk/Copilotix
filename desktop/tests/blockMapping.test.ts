import { describe, expect, it } from 'vitest'
import { buildBlockMappings, stableBlockId } from '@main/blockMapping'

describe('block mapping', () => {
  it('builds deterministic ids from layout para blocks', () => {
    const layout = {
      pdf_info: [
        {
          page_idx: 0,
          page_size: [612, 792],
          para_blocks: [
            { type: 'title', index: 2, bbox: [10, 20, 200, 60] },
            { type: 'text', index: 5, bbox: [10, 80, 500, 200] }
          ]
        }
      ]
    }
    const first = buildBlockMappings('task-1', layout)
    const second = buildBlockMappings('task-1', layout)
    expect(first).toEqual(second)
    expect(first).toHaveLength(2)
    expect(first[0]?.boxes[0]?.blockPosition).toBe('0-2')
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
})
