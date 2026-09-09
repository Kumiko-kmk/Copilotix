import { describe, expect, it } from 'vitest'
import { splitIntoParserBatches } from '@main/taskService'

describe('official Copilotix batch splitting', () => {
  it('splits selections into groups of at most 50 files', () => {
    const values = Array.from({ length: 101 }, (_, index) => index)
    expect(splitIntoParserBatches(values, 50).map((group) => group.length)).toEqual([50, 50, 1])
  })
})
