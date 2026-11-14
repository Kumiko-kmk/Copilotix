// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import ArchiveText from '../../../src/features/library/renderer/archive/ArchiveText'
import SafeMarkdown from '../../../src/features/reader/renderer/components/SafeMarkdown'
import BriefContent from '../../../src/features/library/renderer/archive/BriefContent'
import { briefContent } from '../../fixtures/paperBrief'
import type { PaperBrief } from '../../../src/features/insight/core/paperBrief/schema'

afterEach(cleanup)

describe('archive mathematics', () => {
  it.each(['$x_i^2$', '\\(x_i^2\\)', '$$\n\\frac{x_i}{y_j}\n$$', '\\[\\frac{x_i}{y_j}\\]'])('renders explicit delimiters %s without invalid paragraph nesting', text => {
    const { container } = render(<p><ArchiveText text={text} /></p>)
    expect(container.querySelectorAll('.katex')).toHaveLength(1)
    // CSS comes from the direct KaTeX dependency; rehype must generate that version's DOM.
    expect(container.querySelector('.katex-html > .katex-base')).not.toBeNull()
    expect(container.querySelector('.katex-error')).toBeNull()
    expect(container.querySelector('p p, p div, p pre, p table')).toBeNull()
    expect(container.querySelector('annotation')?.textContent).toMatch(/x_i/)
  })

  it('renders matrices and repairs mismatched sizing just as the reader does', () => {
    const { container } = render(<ArchiveText text={'$\\begin{bmatrix}a&b\\\\c&d\\end{bmatrix}$ 与 $\\left(x+1)$'} />)
    expect(container.querySelectorAll('.katex')).toHaveLength(2)
    expect(container.querySelector('.katex-error')).toBeNull()
  })

  it('handles narrow legacy variables and roots without changing the input', () => {
    const text = 'd_model=512，点积除以 √d_k；N_eff 与 p_data，θ_g。'
    const { container } = render(<ArchiveText text={text} />)
    expect(container.querySelectorAll('.katex')).toHaveLength(5)
    expect(container.querySelectorAll('.katex-error')).toHaveLength(0)
    expect([...container.querySelectorAll('annotation')].map(node => node.textContent)).toEqual([
      'd_{\\mathrm{model}}', '\\sqrt{d_{k}}', 'N_{\\mathrm{eff}}', 'p_{\\mathrm{data}}', 'θ_{g}'
    ])
    expect(text).toBe('d_model=512，点积除以 √d_k；N_eff 与 p_data，θ_g。')
  })

  it('does not reinterpret code, escaped underscores, identifiers, URLs or paths', () => {
    const text = '`d_model`、x\\_i、foo_bar、https://example.com/x_i images/x_i.png C:\\x_i \\$5 和 \\$10。'
    const { container } = render(<ArchiveText text={text} />)
    expect(container.querySelector('.katex')).toBeNull()
    expect(container.querySelector('code')?.textContent).toBe('d_model')
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com/x_i')
  })

  it('does not alter existing formula content or link labels', () => {
    const { container } = render(<ArchiveText text={'$d_model$ [x_i](https://example.com/x_i)'} />)
    expect(container.querySelectorAll('.katex')).toHaveLength(1)
    expect(container.querySelector('annotation')?.textContent).toBe('d_model')
    expect(container.querySelector('a')?.textContent).toBe('x_i')
  })

  it('sanitizes model HTML, suppresses embedded images and keeps malformed math readable', () => {
    const { container } = render(<ArchiveText text={'<script>alert(1)</script>\n\n<img src="https://example.com/pixel" onerror="alert(1)">\n\n[坏链接](javascript:alert(1)) $\\unknowncommand{x}$'} />)
    expect(container.querySelector('script, img, [onerror]')).toBeNull()
    expect(container.querySelector('a')?.getAttribute('href')).toBeNull()
    expect(container.textContent).toContain('\\unknowncommand')
  })

  it('keeps default reader images, tables, citations and formulas unchanged', () => {
    const { container } = render(<SafeMarkdown markdown={'![图](images/a.png)\n\n| A | B |\n|---|---|\n| $x_i$ | 2 |'} assetBaseUrl="copilotix-asset://paper/" />)
    expect(container.querySelector('img')?.getAttribute('src')).toBe('copilotix-asset://paper/images/a.png')
    expect(container.querySelector('.markdown-table-scroll table')).not.toBeNull()
    expect(container.querySelectorAll('.katex')).toHaveLength(1)
    expect(container.querySelector('p')).not.toBeNull()
  })

  it('makes nested Markdown blocks safe inside a compact field', () => {
    const { container } = render(<p><ArchiveText text={'# 标题\n\n**强调**\n\n- 项目\n\n> 引用\n\n```text\nd_model\n```\n\n|A|B|\n|---|---|\n|1|2|'} /></p>)
    expect(container.querySelector('p p, p div, p h1, p ul, p li, p blockquote, p pre, p table, p tr, p td')).toBeNull()
    expect(container.querySelector('strong')?.textContent).toBe('强调')
  })

  it('renders legacy brief fields and preserves excerpt disclosure and saved data without conclusion badges', () => {
    const brief = structuredClone(briefContent) as PaperBrief
    brief.context = { background: '$b_1$', gap: '$b_2$', question: '$b_3$' }
    brief.approach.summary = '$b_4$'
    brief.approach.keyIdeas = ['$b_5$']
    brief.contributions = [{ kind: 'method', text: '$b_6$' }]
    brief.findings = [{ claim: '$f_1$', evidence: '$f_2$', scope: '$f_3$', strength: 'limited', anchors: ['E1'] }]
    brief.checks = [{ grounded: true, numbersVerified: true }]
    brief.limitations = [{ text: '$l_1$', source: 'author' }]
    brief.assumptions = ['$l_2$']
    brief.openQuestions = ['$l_3$']
    const anchors = [{ id: 'E1', section: '$s_1$', text: '$s_2$' }]
    const before = JSON.stringify({ brief, anchors })
    const view = render(<BriefContent brief={brief} anchors={anchors} tab="overview" />)
    expect(view.container.querySelectorAll('.katex')).toHaveLength(3)
    view.rerender(<BriefContent brief={brief} anchors={anchors} tab="findings" />)
    expect(view.container.querySelectorAll('.katex')).toHaveLength(7)
    expect(view.container.querySelector('details summary')).not.toBeNull()
    expect(view.container.querySelector('.paper-archive-badge')).toBeNull()
    view.rerender(<BriefContent brief={brief} anchors={anchors} tab="limits" />)
    expect(view.container.querySelectorAll('.katex')).toHaveLength(4)
    expect(view.container.textContent).toContain('作者自述')
    expect(JSON.stringify({ brief, anchors })).toBe(before)
  })
})
