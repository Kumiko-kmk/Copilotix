import { describe, expect, it } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { normalizeMarkdown, prepareReaderMarkdown, isLocalMarkdownImage } from '../src/shared/standardMarkdown'
import { splitMarkdownMath } from '../src/shared/mathDelimiters'
import { projectFigureMarkdown, type FigureArtifact } from '../src/shared/figureArtifacts'

describe("standardMarkdown", () => {
  const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath)
  const flatten = (node: any): any[] => [node, ...(node.children ?? []).flatMap(flatten)]
  const nodes = (markdown: string): any[] => flatten(parser.parse(markdown))

  describe('rich reader format', () => {
    it('retains merged cells, superscripts, spacing, and code while canonicalizing alternate math', () => {
      const rich = '<table class="results"><tr><td rowspan="2" colspan="3"><sup>12</sup><sub>i</sub><br>  Text</td></tr></table>'
      const code = '`\\(example\\)`\n\n```html\n<img src="code.png">\n```'
      const source = `\uFEFF${rich}\r\n\r\n\\(x^2\\)\n\n${code}\n\n$\\left.{x}$\u000F`
      const result = prepareReaderMarkdown(source)
      expect(result).toContain(rich)
      expect(result).toContain(code)
      expect(result).toContain('$x^2$')
      expect(result).toContain('${x}$�')
      expect(prepareReaderMarkdown(result)).toBe(result)
      expect(normalizeMarkdown(result).markdown).not.toContain('<table')
    })

    it('rebases Markdown, reference, and HTML images without rewriting other HTML or protected examples', () => {
      const source = '<table class="result"><tr><td colspan="2"><img alt="A" src=\'old.png\'><img alt="empty"></td></tr></table>\n\n![plot](old.png)\n\n![ref][a]\n\n[a]: old.png\n\n<pre><img src="old.png"></pre>\n\n`![code](old.png)`'
      const result = prepareReaderMarkdown(source, (url) => url === 'old.png' ? 'paper/a&b".png' : url)
      expect(result).toContain('<table class="result"><tr><td colspan="2"><img alt="A" src="paper/a&amp;b&quot;.png"><img alt="empty"></td></tr></table>')
      expect(nodes(result).filter((node) => node.type === 'image').map((node) => node.url)).toEqual(['paper/a&b".png', 'paper/a&b".png'])
      expect(result).toContain('<pre><img src="old.png"></pre>')
      expect(result).toContain('`![code](old.png)`')
      expect(prepareReaderMarkdown('![same](old.png)', (url) => url)).toBe('![same](old.png)')
    })
  })

  describe('public Markdown format', () => {
    it('repairs invalid delimiter sizing only when removing sizing produces valid TeX', () => {
      const result = normalizeMarkdown(String.raw`$\left({x}\right)$ and $\left({x}\right)}$ and $\left.{x}$`)
      expect(result.mathSizingRepairs).toBe(1)
      expect(result.markdown).toContain(String.raw`$\left({x}\right)$`)
      expect(result.markdown).toContain(String.raw`$\left({x}\right)}$`)
      expect(result.markdown).toContain('${x}$')
      expect(normalizeMarkdown(result.markdown).markdown).toBe(result.markdown)
    })
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
      expect(table.children[0].children[2].children).toEqual([])
      expect(normalizeMarkdown(result.markdown).markdown).toBe(result.markdown)
    })

    it('preserves a long merged caption once rather than duplicating it across rows and columns', () => {
      const caption = 'Table caption with a sufficiently long explanation of all experimental results.'
      const result = normalizeMarkdown(`<table><tr><td>A</td><td>B</td><td>C</td></tr><tr><td rowspan="2" colspan="2">${caption}</td><td>1</td></tr><tr><td>2</td></tr></table>`).markdown
      expect(result.split(caption)).toHaveLength(2)
      expect(nodes(result).find((node) => node.type === 'table').children.map((row: any) => row.children.length)).toEqual([3, 3, 3])
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
      expect(normalizeMarkdown('<math><mfrac><mi>x</mi><mi>y</mi></mfrac><msup><mi>z</mi><mn>2</mn></msup></math>').markdown).toContain(String.raw`$\frac{x}{y}{z}^{2}$`)
      expect(normalizeMarkdown('<table><caption>Empty</caption></table>').markdown).toContain('Empty')
      expect(() => normalizeMarkdown('<table><tr><td colspan="999999">X</td></tr></table>')).toThrow('超出支持上限')
    })

    it.each(['images/a.png', './a%20b.svg'])('identifies local images: %s', (url) => expect(isLocalMarkdownImage(url)).toBe(true))
    it.each(['', '#anchor', 'https://example.org/a.png', '//example.org/a.png', 'data:image/png;base64,AA', 'copilotix-asset://id/a.png'])('identifies nonlocal images: %s', (url) => expect(isLocalMarkdownImage(url)).toBe(false))
  })
})

describe("mathDelimiters", () => {
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
})

describe("figureArtifacts", () => {
  const figure: FigureArtifact = {
    figureId: 'figure-1', imagePath: 'images/figures/figure-p1-abcdef.png', sourceRevision: 'revision',
    pageIndex: 0, cropBox: [0, 0, 100, 100], mappingIds: ['a', 'b', 'caption'], sourceAssets: ['a.png', 'b.png'],
    width: 100, height: 100, pngSha256: 'hash'
  }

  describe('whole figure Markdown projection', () => {
    it('replaces only owned image references and keeps mixed prose, captions and unrelated assets', () => {
      const source = 'Before.\n\n![A](images/a.png)\n\nMiddle.\n\n<img src="images/b.png">\n\n![Other](images/other.png)\n\nFigure 1. First paragraph.\n\nSecond paragraph.'
      const projected = projectFigureMarkdown(source, [figure])
      expect(projected.match(/images\/figures/gu)).toHaveLength(1)
      expect(projected).not.toContain('images/a.png')
      expect(projected).not.toContain('images/b.png')
      expect(projected).toContain('Middle.')
      expect(projected).toContain('images/other.png')
      expect(projected).toContain('Second paragraph.')
    })
    it('preserves conflicting, remote and unavailable sources and supports reference-style images', () => {
      const conflict = { ...figure, figureId: 'figure-2' }
      expect(projectFigureMarkdown('![](images/a.png)', [figure, conflict])).toBe('![](images/a.png)')
      expect(projectFigureMarkdown('![](https://example.com/a.png)', [figure])).toBe('![](https://example.com/a.png)')
      expect(projectFigureMarkdown('![A][panel]\n\n[panel]: images/a.png', [figure])).toContain('![](images/figures/')
      expect(projectFigureMarkdown('<div><img src="images/a.png"></div>', [figure])).toContain('<img src="images/figures/')
      expect(projectFigureMarkdown('![](images/a.png)', [])).toBe('![](images/a.png)')
    })
  })
})
