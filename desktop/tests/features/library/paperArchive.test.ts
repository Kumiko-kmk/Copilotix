import { describe, expect, it, vi } from 'vitest'
vi.mock('../../../src/platform/pdf/renderer/pdfDocumentCache', () => ({ acquirePdfDocument: vi.fn() }))
import { loadDetailPage, type DetailPage } from '../../../src/features/library/renderer/archive/detailPage'
import { type DocumentSummary } from '../../../src/shared/ipcSchemas'
import { ArchiveMomentum, damp, settlingWave, SHOULDER_PEAK } from '../../../src/features/library/renderer/archive/archiveMotion'
import { ALL_PAPERS, buildArchiveColumns, cellForPaper, groupPapersByCategory, laneStep, nearestOccurrence, paperAt, paperIndexAt, wrap, type ArchivePaper } from '../../../src/features/library/renderer/archive/archiveShelves'
import { cleanInline, extractPaperProfile } from '../../../src/features/library/core/paperProfile'
import { layoutSpreadFigures, parseFigureManifest, rankSpreadFigures, type SpreadCandidate } from '../../../src/features/library/renderer/archive/figureSpread'

describe("paperArchive", () => {
  let sequence = 0
  function paper(createdAt: string, status: DocumentSummary['workflow']['status'] = 'completed'): ArchivePaper {
    sequence++
    return {
      id: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
      displayName: `paper-${sequence}.pdf`,
      originalName: `paper-${sequence}.pdf`,
      createdAt,
      workflow: { status, progress: 100, activeJobKind: null, error: null }
    }
  }

  const october = '2026-10-15T10:00:00.000Z'

  describe('paper archive shelves', () => {
    it('shows the whole library as one shelf, newest first, until categories arrive', () => {
      const older = paper('2026-08-12T10:00:00.000Z')
      const newer = paper('2026-10-20T10:00:00.000Z')
      const shelves = groupPapersByCategory([older, newer])
      expect(shelves.map((shelf) => [shelf.key, shelf.label, shelf.category])).toEqual([['all', ALL_PAPERS, ALL_PAPERS]])
      expect(shelves[0]!.papers.map((item) => item.id)).toEqual([newer.id, older.id])
      expect(groupPapersByCategory([])).toEqual([])
    })

    it('follows the category order and the order of papers within each category', () => {
      const [a, b, c, d] = [paper(october), paper(october), paper(october), paper(october)]
      const shelves = groupPapersByCategory([a!, b!, c!, d!], [
        { id: 'c-operators', name: '神经算子', paperIds: [c!.id, a!.id] },
        { id: 'c-attention', name: '注意力机制', paperIds: [b!.id, 'deleted-paper'] }
      ])
      expect(shelves.map((shelf) => shelf.label)).toEqual(['神经算子', '注意力机制', '待分类'])
      expect(shelves[0]!.papers).toEqual([c, a])
      // A paper imported after the categories were computed waits in 待分类.
      expect(shelves[2]!.papers).toEqual([d])
    })

    it('adds papers the categories do not know to an existing 待分类 shelf', () => {
      const [a, b] = [paper(october), paper(october)]
      const shelves = groupPapersByCategory([a!, b!], [{ id: 'pending', name: '待分类', paperIds: [a!.id] }])
      expect(shelves.map((shelf) => [shelf.key, shelf.papers.length])).toEqual([['pending', 2]])
    })

    it('loops rows and lanes in both directions', () => {
      const [a, b, c] = [paper(october), paper(october), paper(october)]
      const shelves = groupPapersByCategory([a!, b!, c!], [{ id: 'c-x', name: 'X', paperIds: [a!.id, b!.id] }, { id: 'c-y', name: 'Y', paperIds: [c!.id] }])
      expect(wrap(-1, 3)).toBe(2)
      expect(paperAt(shelves, { lane: 0, row: 2 })).toBe(shelves[0]!.papers[0]!)
      expect(paperAt(shelves, { lane: -1, row: -5 })).toBe(shelves[1]!.papers[0]!)
      expect(paperIndexAt(shelves, { lane: 2, row: -1 })).toBe(1)
      expect(paperAt([], { lane: 0, row: 0 })).toBeNull()
    })

    it('finds the nearest occurrence so the plane never travels across a whole loop', () => {
      expect(nearestOccurrence(0, 7, 8)).toBe(8)
      expect(nearestOccurrence(3, -6, 8)).toBe(-5)
      const shelves = groupPapersByCategory([paper('2026-10-10T10:00:00.000Z'), paper('2026-10-11T10:00:00.000Z')])
      expect(cellForPaper(shelves, shelves[0]!.papers[1]!.id, { lane: 4, row: 9 })).toEqual({ lane: 4, row: 9 })
      expect(cellForPaper(shelves, 'missing', { lane: 0, row: 0 })).toBeNull()
    })

    it('returns to the paper last viewed on a shelf when stepping sideways', () => {
      const papers = [paper(october), paper(october), paper(october), paper(october)]
      const shelves = groupPapersByCategory(papers, [
        { id: 'c-x', name: 'X', paperIds: [papers[0]!.id] },
        { id: 'c-y', name: 'Y', paperIds: papers.slice(1).map((item) => item.id) }
      ])
      const remembered = shelves[1]!.papers[2]!
      const next = laneStep(shelves, { lane: 0, row: 10 }, 1, new Map([[shelves[1]!.key, remembered.id]]))
      expect(next.lane).toBe(1)
      expect(paperAt(shelves, next)).toBe(remembered)
      expect(Math.abs(next.row - 10)).toBeLessThanOrEqual(1)
      expect(paperAt(shelves, laneStep(shelves, { lane: 0, row: 0 }, -1, new Map()))).toBe(shelves[1]!.papers[0]!)
    })
  })

  describe('paper archive columns', () => {
    it('keeps all papers in a large category in one looping column', () => {
      const papers = Array.from({ length: 37 }, () => paper(october))
      const columns = buildArchiveColumns(papers, [{ id: 'c-big', name: '神经算子', paperIds: papers.map((item) => item.id) }])
      expect(columns).toHaveLength(1)
      expect(columns.every((column) => column.category === '神经算子')).toBe(true)
      expect(columns[0]!.papers).toEqual(papers)
      expect(columns[0]!.label).toBe('神经算子')
      expect(columns[0]!.key).toBe('c-big')
      expect(paperAt(columns, { lane: 0, row: 37 })).toBe(papers[0])
      expect(paperAt(columns, { lane: 0, row: -1 })).toBe(papers[36])
      expect(columns.flatMap((column) => column.papers)).toHaveLength(37)
    })

    it('keeps small categories as single columns', () => {
      const [a, b] = [paper(october), paper(october)]
      const columns = buildArchiveColumns([a!, b!], [{ id: 'c-x', name: '扩散模型', paperIds: [a!.id] }, { id: 'c-y', name: '图网络', paperIds: [b!.id] }])
      expect(columns.map((column) => [column.key, column.label])).toEqual([['c-x', '扩散模型'], ['c-y', '图网络']])
    })
  })

  describe('paper archive motion', () => {
    it('keeps the resting shoulder highest at the selection and settling outward', () => {
      expect(SHOULDER_PEAK).toBeGreaterThan(2)
      expect(settlingWave(6)).toBeLessThan(SHOULDER_PEAK)
      expect(settlingWave(20)).toBeLessThan(settlingWave(6))
      expect(settlingWave(-6)).toBeCloseTo(settlingWave(6))
    })

    it('damps springs onto their target', () => {
      const spring = { value: 0, velocity: 0 }
      for (let step = 0; step < 240; step++) damp(spring, 1, 5, 1 / 60)
      expect(spring.value).toBeCloseTo(1, 3)
    })

    it('coasts a released drag and snaps to a whole cell', () => {
      const momentum = new ArchiveMomentum(0.2, 6)
      for (let step = 0; step < 600 && momentum.phase !== 'idle'; step++) momentum.step(1 / 60)
      expect(momentum.phase).toBe('idle')
      expect(Number.isInteger(momentum.value)).toBe(true)
      expect(momentum.value).toBeGreaterThan(1)
    })
  })
})

describe("paperProfile", () => {
  const ORIGINAL = [
    'Provided proper attribution is provided, the tables may be reproduced.',
    '# Attention Is All You Need',
    'Ashish Vaswani∗ Google Brain [avaswani@google.com](mailto:avaswani@google.com)',
    'Noam Shazeer<sup>†</sup> Google Brain <noam@google.com>',
    '## Abstract',
    'The dominant sequence transduction models are based on complex recurrent networks.',
    'We propose a new simple network architecture, the **Transformer**.',
    'Keywords: attention, sequence modeling; machine translation',
    '## 1 Introduction',
    'Recurrent neural networks ![fig](images/a.png)',
    '## 3 Model Architecture',
    '## 3.1 Encoder and Decoder Stacks',
    '$$\nQ K^T\n$$',
    '<table><tr><td>BLEU</td></tr></table>',
    '| a | b |\n| --- | --- |\n| 1 | 2 |',
    '## Acknowledgements',
    'Thanks.',
    '## References',
    '[1] Jimmy Lei Ba. Layer normalization.\n[2] Dzmitry Bahdanau. Neural machine translation.',
    '[3] Denny Britz. Massive exploration.'
  ].join('\n\n')

  const TRANSLATED = [
    '# 注意力就是一切',
    '阿希什·瓦斯瓦尼∗ 谷歌大脑',
    '## 摘要',
    '主流的序列转换模型基于复杂的循环网络。',
    '## 1 引言',
    '## 3 模型架构',
    '## 3.1 编码器与解码器堆栈',
    '## 参考文献'
  ].join('\n\n')

  describe('paper profile', () => {
    it('preserves maths and code in archive abstracts and headings while plain projection stays compatible', () => {
      const source = '# 模型 $x_i$\n\n## 摘要\n\n求解 $a < b$，使用 \\(\\alpha_i\\) 与 `x_i`。\n\n## 1 估计 $N_{eff}$'
      const profile = extractPaperProfile(source, source, true)
      expect(profile.translatedTitle).toBe('模型 $x_i$')
      expect(profile.translatedAbstract).toBe('求解 $a < b$，使用 $\\alpha_i$ 与 `x_i`。')
      expect(profile.sections).toEqual(['1 估计 $N_{eff}$'])
      expect(cleanInline('变量 $x_i$ 与 `x_i`')).toBe('变量 x_i 与 x_i')
      expect(extractPaperProfile(source, source).sections).toEqual(['1 估计 N_{eff}'])
    })
    it('decodes Markdown escapes without stripping literal underscores or mathematical text', () => {
      expect(cleanInline('在 x\\_i 与 y\\_j 上编码函数，参考\\[5\\]，**加粗**与`a_b`。')).toBe('在 x_i 与 y_j 上编码函数，参考[5]，加粗与a_b。')
      expect(cleanInline('公式 $x_i + y_j$ 与 $a < b$。')).toBe('公式 x_i + y_j 与 a < b。')
      expect(cleanInline('Literal \\\\_path and https://example.com/a_b_c', true)).toBe('Literal \\_path and https://example.com/a_b_c')
    })
    it('preserves abstract link destinations in autolink, Markdown and HTML forms', () => {
      const url = 'https://github.com/hojonathanho/diffusion'
      for (const link of [`<${url}>`, `[代码](${url})`, `<a href="${url}">代码</a>`, `<${url}/some_code_here>`]) {
        const translated = `# 扩散模型\n\n## 摘要\n\n我们展示了图像合成结果，实现可见 ${link}。\n\n## 引言`
        expect(extractPaperProfile('', translated).translatedAbstract).toContain(link.includes('some_code_here') ? `${url}/some_code_here` : url)
      }
    })
    it('reads title, authors, abstracts, keywords and top-level sections', () => {
      const profile = extractPaperProfile(ORIGINAL, TRANSLATED)
      expect(profile.title).toBe('Attention Is All You Need')
      expect(profile.translatedTitle).toBe('注意力就是一切')
      expect(profile.authors).toBe('Ashish Vaswani Google Brain；Noam Shazeer Google Brain')
      expect(profile.abstract).toBe('The dominant sequence transduction models are based on complex recurrent networks. We propose a new simple network architecture, the Transformer.')
      expect(profile.translatedAbstract).toBe('主流的序列转换模型基于复杂的循环网络。')
      expect(profile.keywords).toEqual(['attention', 'sequence modeling', 'machine translation'])
      expect(profile.sections).toEqual(['1 引言', '3 模型架构'])
    })

    it('counts figures, tables, equations and references from the source', () => {
      expect(extractPaperProfile(ORIGINAL).counts).toEqual({ figures: 1, tables: 2, equations: 1, references: 3 })
    })

    it('accepts an inline abstract paragraph and missing translations', () => {
      const profile = extractPaperProfile('# Title\n\nA. Author\n\nAbstract—We study a sufficiently long problem statement here.\n\n# I. Introduction')
      expect(profile.abstract).toBe('We study a sufficiently long problem statement here.')
      expect(profile.authors).toBe('A. Author')
      expect(profile.translatedTitle).toBeNull()
      expect(profile.sections).toEqual(['I. Introduction'])
    })

    it('finds journal bylines and unlabelled abstracts without taking dates or prose as authors', () => {
      const abstract = 'The finite element method solves partial differential equations. '.repeat(5).trim()
      const paper = ['Article', '# NOEM: reusable neural operators', 'Received: 6 July 2025', 'Accepted: 27 February 2026',
        'Published online: 28 April 2026', 'Check for updates',
        'Weihang Ouyang<sup>1,2</sup>, Yeonjong Shin<sup>3</sup>, Si-Wei Liu<sup>1</sup> & Lu Lu<sup>2,4</sup>', abstract,
        'Efficient numerical simulation methods are crucial. '.repeat(5), '# Results'].join('\n\n')
      expect(extractPaperProfile(paper)).toMatchObject({
        authors: 'Weihang Ouyang, Yeonjong Shin, Si-Wei Liu & Lu Lu', abstract
      })
      expect(extractPaperProfile(paper.replace(/Weihang Ouyang.*?\n\n/u, '')).authors).toBeNull()
      expect(extractPaperProfile(paper.replace(/Weihang Ouyang.*?\n\n/u, '')).abstract).toBeNull()
    })

    it('keeps long multilingual bylines and stops front matter at Contents instead of requiring Abstract', () => {
      const names = Array.from({ length: 45 }, (_, i) => `John Jumper<sup>${i + 1}</sup>`).join(', ')
      const abstract = 'Proteins are essential to life and their structures explain their functions. '.repeat(5).trim()
      const profile = extractPaperProfile(`# AlphaFold\n\n${names}\n\n${abstract}`)
      expect(profile.authors).toBe(Array.from({ length: 45 }, () => 'John Jumper').join(', '))
      expect(profile.abstract).toBe(abstract)
      const book = '# Geometric Deep Learning\n\nMichael M. Bronstein, Joan Bruna, Taco Cohen, Petar Veličković\n\nMay 4, 2021\n\n## Contents\n\nPreface ... 1\n\n## Preface\n\n' + abstract
      expect(extractPaperProfile(book)).toMatchObject({ authors: 'Michael M. Bronstein, Joan Bruna, Taco Cohen, Petar Veličković', abstract: null })
      for (const heading of ['Related Work', 'Problem Formulation']) {
        expect(extractPaperProfile(`# Paper\n\nA. Author\n\n## ${heading}\n\n${abstract}`)).toMatchObject({authors: 'A. Author', abstract: null})
      }
      expect(extractPaperProfile('# Paper\n\nReceived: 6 July 2025\n\n' + 'Neural operators approximate PDE solution families with learned representations across multiple spatial scales. '.repeat(5)).authors).toBeNull()
      expect(extractPaperProfile('# 中文论文\n\n张三，李四\n\n## 摘要\n\n本文研究具体问题。').authors).toBe('张三，李四')
    })

    it('returns empty facts for an empty document', () => {
      expect(extractPaperProfile('')).toEqual({
        title: null, translatedTitle: null, authors: null, abstract: null, translatedAbstract: null,
        keywords: [], sections: [], counts: { figures: 0, tables: 0, equations: 0, references: 0 }
      })
    })
  })
})

describe("figureSpread", () => {
  const SHEET = { width: 1236, height: 1600 }

  function candidate(figureId: string, aspect: number, weight = 1): SpreadCandidate {
    return { figureId, imagePath: `images/figures/${figureId}.png`, aspect, weight }
  }

  function manifestFigure(figureId: string, pageIndex: number, width = 1800, height = 700, area = 100) {
    return { figureId, imagePath: `images/figures/${figureId}.png`, width, height, pageIndex, cropBox: [0, 0, area, 100] }
  }

  describe('layoutSpreadFigures', () => {
    it('keeps every figure inside the sheet margins, readable and without overlaps', () => {
      const placements = layoutSpreadFigures([candidate('a', 1.1), candidate('b', 3), candidate('c', 2.2), candidate('d', 0.8), candidate('e', 2.6)], SHEET)
      expect(placements.length).toBeGreaterThan(0)
      expect(placements.length).toBeLessThanOrEqual(6)
      for (const [index, placement] of placements.entries()) {
        expect(placement.x).toBeGreaterThan(0)
        expect(placement.y).toBeGreaterThan(0)
        expect(placement.x + placement.width).toBeLessThan(SHEET.width)
        expect(placement.y + placement.height).toBeLessThan(SHEET.height)
        expect(Math.min(placement.width, placement.height)).toBeGreaterThanOrEqual(SHEET.width * 0.83 * 0.24 - 0.5)
        for (const other of placements.slice(index + 1)) {
          const apart = placement.x + placement.width <= other.x || other.x + other.width <= placement.x
            || placement.y + placement.height <= other.y || other.y + other.height <= placement.y
          expect(apart).toBe(true)
        }
      }
    })

    it('shows more figures when they keep a readable size', () => {
      const placements = layoutSpreadFigures([candidate('a', 1.6), candidate('b', 0.62), candidate('c', 1.33), candidate('d', 0.77), candidate('e', 2.68)], SHEET)
      expect(placements.length).toBeGreaterThanOrEqual(4)
    })

    it('places figures in rank order and never puts two wide figures side by side', () => {
      const placements = layoutSpreadFigures([candidate('a', 3), candidate('b', 3.2), candidate('c', 2.8), candidate('d', 3)], SHEET)
      expect(placements[0]!.figureId).toBe('a')
      const rows = new Set(placements.map((placement) => Math.round(placement.y)))
      expect(rows.size).toBe(placements.length)
    })

    it('shows a single figure alone, centred, and nothing without candidates', () => {
      const [only] = layoutSpreadFigures([candidate('a', 1.3)], SHEET)
      expect(only!.x + only!.width / 2).toBeCloseTo(SHEET.width / 2, 0)
      expect(only!.y + only!.height / 2).toBeCloseTo(SHEET.height / 2, 0)
      expect(layoutSpreadFigures([], SHEET)).toEqual([])
    })
  })

  describe('rankSpreadFigures', () => {
    it('ranks scored figures by displayWeight before unscored ones and drops zero scores', () => {
      const figures = [manifestFigure('late', 9), manifestFigure('scored-low', 4), manifestFigure('formula', 2), manifestFigure('scored-high', 6)]
      const ranked = rankSpreadFigures(figures, new Map([['scored-low', 40], ['scored-high', 90], ['formula', 0]]))
      expect(ranked.map((figure) => figure.figureId)).toEqual(['scored-high', 'scored-low', 'late'])
    })

    it('skips figures on the first page and extreme strips', () => {
      const ranked = rankSpreadFigures([manifestFigure('cover', 0), manifestFigure('strip', 3, 1800, 200), manifestFigure('kept', 3)], new Map())
      expect(ranked.map((figure) => figure.figureId)).toEqual(['kept'])
    })

    it('prefers earlier and larger figures when nothing is scored', () => {
      const ranked = rankSpreadFigures([manifestFigure('appendix', 20, 1800, 700, 100), manifestFigure('method', 2, 1800, 700, 100)], new Map())
      expect(ranked[0]!.figureId).toBe('method')
    })
  })

  describe('parseFigureManifest', () => {
    it('accepts only well-formed figures with paths inside images/figures', () => {
      const figures = parseFigureManifest({ version: 1, figures: [
        manifestFigure('ok', 2),
        { ...manifestFigure('escape', 2), imagePath: '../secret.png' },
        { ...manifestFigure('broken', 2), width: 0 }
      ] })
      expect(figures.map((figure) => figure.figureId)).toEqual(['ok'])
      expect(parseFigureManifest(null)).toEqual([])
    })
  })
})

it('reopens a cancelled cover without letting its late rejection evict the replacement', async () => {
  const controller = new AbortController()
  let rejectOld!: (error: Error) => void
  const old = loadDetailPage('cancel-reopen', () => new Promise((_, reject) => { rejectOld = reject }), controller.signal)
  controller.abort()
  const page = { canvas: {} as HTMLCanvasElement, pages: 3 } satisfies DetailPage
  const replacement = vi.fn(async () => page)
  await expect(loadDetailPage('cancel-reopen', replacement)).resolves.toBe(page)
  rejectOld(new Error('cancelled render'))
  await expect(old).rejects.toThrow('cancelled render')
  await expect(loadDetailPage('cancel-reopen', replacement)).resolves.toBe(page)
  expect(replacement).toHaveBeenCalledTimes(1)
})

it('retains a completed cover after its view closes', async () => {
  const controller = new AbortController()
  const page = { canvas: {} as HTMLCanvasElement, pages: 2 } satisfies DetailPage
  const render = vi.fn(async () => page)
  await expect(loadDetailPage('completed-cover', render, controller.signal)).resolves.toBe(page)
  controller.abort()
  await expect(loadDetailPage('completed-cover', render)).resolves.toBe(page)
  expect(render).toHaveBeenCalledTimes(1)
})
