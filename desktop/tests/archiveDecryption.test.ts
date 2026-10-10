import { describe, expect, it } from 'vitest'
import { DECRYPTION_SECONDS, decryptionFrame, redactionOffset } from '../src/renderer/paperArchive/archiveDecryption'

describe('archive decryption timeline', () => {
  it('draws the diagonal in, holds it, draws it back, then clears the glass', () => {
    expect(DECRYPTION_SECONDS).toBeGreaterThan(1.2)
    expect(DECRYPTION_SECONDS).toBeLessThan(1.4)
    const joining = decryptionFrame(0.2)
    expect(joining.phase).toBe('joining')
    expect(joining.intervals).toHaveLength(2)
    expect(joining.clarity).toBe(0)
    const connected = decryptionFrame(0.6)
    expect(connected.phase).toBe('connected')
    expect(connected.intervals).toEqual([[0, 1]])
    expect(decryptionFrame(0.85).phase).toBe('retracting')
    // The glass, and with it the text, starts to clear about 1 s in.
    expect(decryptionFrame(0.97).clarity).toBe(0)
    const revealing = decryptionFrame(1.1)
    expect(revealing.phase).toBe('revealing')
    expect(revealing.clarity).toBeGreaterThan(0)
    expect(revealing.intervals).toEqual([])
    const clear = decryptionFrame(DECRYPTION_SECONDS + 0.01)
    expect(clear).toMatchObject({ phase: 'clear', clarity: 1, markers: 0 })
  })

  it('never lets glass clarity go backwards', () => {
    let previous = 0
    for (let time = 0; time <= DECRYPTION_SECONDS + 0.1; time += 0.01) {
      const { clarity } = decryptionFrame(time)
      expect(clarity).toBeGreaterThanOrEqual(previous - 1e-9)
      previous = clarity
    }
  })

  it('slides each line out in reading order and finishes every line', () => {
    expect(redactionOffset(0, 0, 5)).toBe(0)
    expect(redactionOffset(0.3, 0, 5)).toBeGreaterThan(redactionOffset(0.3, 4, 5))
    for (let order = 0; order < 5; order++) expect(redactionOffset(1, order, 5)).toBeCloseTo(1)
  })
})
