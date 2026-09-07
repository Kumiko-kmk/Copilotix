import { describe, expect, it } from 'vitest'
import { splitMarkdownMath } from '../src/shared/mathDelimiters'

describe('splitMarkdownMath', () => {
  it('recognizes all supported inline and display delimiters', () => {
    expect(splitMarkdownMath('A $x$ B $$y$$ C \\(z\\) D \\[w\\]')).toEqual([
      { kind: 'text', value: 'A ' },
      { kind: 'math', value: '$x$', content: 'x', display: false },
      { kind: 'text', value: ' B ' },
      { kind: 'math', value: '$$y$$', content: 'y', display: true },
      { kind: 'text', value: ' C ' },
      { kind: 'math', value: '\\(z\\)', content: 'z', display: false },
      { kind: 'text', value: ' D ' },
      { kind: 'math', value: '\\[w\\]', content: 'w', display: true }
    ])
  })

  it('does not guess unclosed formulas or currency amounts', () => {
    expect(splitMarkdownMath('Price $100; unfinished $x')).toEqual([
      { kind: 'text', value: 'Price $100; unfinished $x' }
    ])
    expect(splitMarkdownMath('Scale $2x$')).toEqual([
      { kind: 'text', value: 'Scale ' },
      { kind: 'math', value: '$2x$', content: '2x', display: false }
    ])
  })
})
