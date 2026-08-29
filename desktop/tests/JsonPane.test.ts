import { describe, expect, it } from 'vitest'
import { jsonSearchExcerpt } from '../src/renderer/components/JsonPane'

describe('JSON reader', () => {
  it('finds literal queries containing regular-expression characters without copying the full lowercase JSON', () => {
    const prefix = 'x'.repeat(700)
    const suffix = 'y'.repeat(2_000)
    const result = jsonSearchExcerpt(prefix + '{"value":"[a+b]"}' + suffix, '[a+b]')

    expect(result.startsWith('…\n')).toBe(true)
    expect(result).toContain('"value":"[a+b]"')
    expect(result.endsWith('\n…')).toBe(true)
    expect(result.length).toBeLessThan(prefix.length + suffix.length)
  })
})
