// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { paperSelectionText } from '../src/utility/core/paperSelectionText'
import SafeMarkdown from '../src/renderer/components/SafeMarkdown'

afterEach(cleanup)
const compact = (s: string): string => s.replace(/\s/gu, '')
describe('trusted paper selection text projection', () => {
  it.each([
    'A **bold** and *emphasized* contribution using [attention](https://example.test).',
    'The formula $x^2 + y$ explains **attention**.',
    '$$\nE = mc^2\n$$',
    '<table><tbody><tr><td>Model $x^2$</td><td>&amp; H<sub>2</sub>O</td></tr></tbody></table>',
    '### Heading\n\n`code` and &amp; an escaped \\* symbol.\n\n- first\n- second',
    '<script>untrusted()</script>\n\nSafe text.',
  ])('matches actual sanitized reader DOM text, including KaTeX, for %s', (source) => {
    const view = render(<SafeMarkdown markdown={source} assetBaseUrl="https://assets.example.test/" />)
    expect(compact(paperSelectionText(source))).toBe(compact(view.container.textContent ?? ''))
  })
})
