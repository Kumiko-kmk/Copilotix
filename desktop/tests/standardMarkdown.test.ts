import { describe, expect, it } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { normalizeMarkdown, isLocalMarkdownImage } from '../src/shared/standardMarkdown'

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath)
const flatten = (node: any): any[] => [node, ...(node.children ?? []).flatMap(flatten)]
const nodes = (markdown: string): any[] => flatten(parser.parse(markdown))

describe('public Markdown format', () => {
  it('expands parser HTML spans into a rectangular GFM table without duplicating images', () => {
    const source = '<table><caption>Results</caption><tr><th rowspan="2">Model</th><th colspan="2">Score</th></tr><tr><td>A</td><td>B</td></tr><tr><td colspan="2"><img src="images/figure.png" alt="plot">DDPM</td><td>3.17</td></tr></table>'
    const result = normalizeMarkdown(source)
    const table = nodes(result.markdown).find((node) => node.type === 'table')
    expect(table.children.map((row: any) => row.children.length)).toEqual([3, 3, 3])
    expect(table.children[1].children[0].children[0].value).toBe('Model')
    expect(nodes(result.markdown).filter((node) => node.type === 'image')).toHaveLength(1)
    expect(nodes(result.markdown).filter((node) => node.type === 'html')).toHaveLength(0)
    expect(result.tablesConverted).toBe(1)
    expect(result.markdown).toContain('Results')
    expect(normalizeMarkdown(result.markdown).markdown).toBe(result.markdown)
  })

  it('preserves math as math, including norm operators inside generated tables', () => {
    const source = String.raw`Inline \(x^2\).` + '\n\n' + String.raw`\[\frac{x}{y}\]` + '\n\n' + String.raw`<table><tr><td>Objective</td></tr><tr><td>$\left\|x\right\|^2 + |y|$</td></tr></table>`
    const result = normalizeMarkdown(source).markdown
    const math = nodes(result).filter((node) => ['math', 'inlineMath'].includes(node.type))
    expect(math.map((node) => node.value)).toContain('x^2')
    expect(math.map((node) => node.value)).toContain(String.raw`\frac{x}{y}`)
    expect(result).toContain(String.raw`\left\Vert x\right\Vert ^2 + \vert y\vert`)
    expect(nodes(result).filter((node) => node.type === 'code')).toHaveLength(0)
    expect(nodes(result).find((node) => node.type === 'table').children[1].children).toHaveLength(1)
    expect(normalizeMarkdown(result).markdown).toBe(result)
  })

  it('preserves inline HTML emphasis, links, images and superscripts with surrounding Markdown', () => {
    const result = normalizeMarkdown('A <b>bold *emphasis*</b> <a href="https://example.org">link</a> <sup>2</sup> <sub>i</sub> <img src="images/a.png" alt="A">.').markdown
    expect(result).toContain('**bold *emphasis***')
    expect(result).toContain('[link](https://example.org)')
    expect(result).toContain('${}^{2}$')
    expect(result).toContain('${}_{i}$')
    expect(result).toContain('![A](images/a.png)')
    expect(nodes(result).some((node) => node.type === 'html')).toBe(false)
  })

  it('converts HTML block structures and preserves nested lists and code literally', () => {
    const result = normalizeMarkdown('<div><h2>Section</h2><blockquote><p>Quoted</p></blockquote><ol start="3"><li>First<ul><li>Nested</li></ul></li></ol><pre>&lt;table&gt;\n\\(not math\\)</pre><hr><script>bad()</script><style>bad</style><!-- comment --></div>').markdown
    expect(result).toContain('## Section')
    expect(result).toContain('> Quoted')
    expect(result).toContain('3. First')
    expect(result).toContain('   - Nested')
    expect(nodes(result).find((node) => node.type === 'code').value).toBe('<table>\n\\(not math\\)')
    expect(result).not.toContain('bad')
    expect(nodes(result).some((node) => node.type === 'thematicBreak')).toBe(true)
  })

  it('leaves fenced and inline code opaque, including HTML and alternate math delimiters', () => {
    const source = '```html\n<table>\\(x\\)</table>\n```\n\n`\\[literal\\]`'
    const result = normalizeMarkdown(source)
    expect(nodes(result.markdown).filter((node) => node.type === 'math' || node.type === 'inlineMath')).toHaveLength(0)
    expect(nodes(result.markdown).find((node) => node.type === 'code').value).toBe('<table>\\(x\\)</table>')
  })

  it('resolves shared references with the first definition and rewrites only images', () => {
    const result = normalizeMarkdown('![plot][A] and [link][A].\n\n[A]: images/chart.png "figure"\n[A]: wrong.png', (url) => `export/${url}`).markdown
    expect(result).toContain('![plot](export/images/chart.png "figure")')
    expect(result).toContain('[link](images/chart.png "figure")')
    expect(result).not.toContain('export/wrong.png')
  })

  it('replaces invisible invalid controls visibly, with UTF-8, LF and stable normalization', () => {
    const result = normalizeMarkdown('\uFEFF# 标题\r\n\r\n正文\u000F内容\u0000结束\r\n')
    expect(result.controlsReplaced).toBe(2)
    expect(result.markdown).toBe('# 标题\n\n正文�内容�结束\n')
    expect(normalizeMarkdown(result.markdown).markdown).toBe(result.markdown)
  })

  it('keeps pipes, backticks, entities, URLs and multiple paragraphs in table cells readable', () => {
    const result = normalizeMarkdown('<table><tr><td>A | B</td><td><code>x|y</code></td></tr><tr><td><p>One &amp; two</p><p>Three</p></td><td>https://example.org/path</td></tr></table>').markdown
    const table = nodes(result).find((node) => node.type === 'table')
    expect(table.children.every((row: any) => row.children.length === 2)).toBe(true)
    expect(nodes(result).find((node) => node.type === 'inlineCode').value).toBe('x|y')
    expect(result).toContain('One & two Three')
    expect(result).toContain('[https://example.org/path](https://example.org/path)')
    expect(normalizeMarkdown(result).markdown).toBe(result)
  })

  it('preserves TeX annotations from MathML and refuses unbounded table spans', () => {
    expect(normalizeMarkdown('<math><annotation encoding="application/x-tex">x^2</annotation></math>').markdown).toContain('$x^2$')
    expect(normalizeMarkdown('<table><caption>Empty</caption></table>').markdown).toContain('Empty')
    expect(() => normalizeMarkdown('<table><tr><td colspan="999999">X</td></tr></table>')).toThrow('超出支持上限')
  })

  it.each(['images/a.png', './a%20b.svg'])('identifies local images: %s', (url) => expect(isLocalMarkdownImage(url)).toBe(true))
  it.each(['', '#anchor', 'https://example.org/a.png', '//example.org/a.png', 'data:image/png;base64,AA', 'copilotix-asset://id/a.png'])('identifies nonlocal images: %s', (url) => expect(isLocalMarkdownImage(url)).toBe(false))
})
