// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ArchiveDetail from '../src/renderer/paperArchive/ArchiveDetail'
import { briefGeneration } from './fixtures/paperBrief'
import { parseBriefResponse, assembleBrief, buildFullBriefContext } from '../src/shared/paperBrief'
import type { PaperInsightSource } from '../src/shared/paperInsight'

const query = vi.hoisted(() => ({ data: undefined as undefined | { markdown: string; translatedMarkdown: string; summary: { updatedAt: string } } }))
vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({ isPending: !query.data, data: query.data }), useQueryClient: () => ({}) }))
beforeEach(() => { query.data = undefined; vi.stubGlobal('matchMedia', () => ({ matches: true })) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('renders all legacy v1 fields and preserves navigation and saved data', async () => {
  const insight = {
    summary: '$a_1$', researchQuestion: '$a_2$', method: '$a_3$',
    contributions: ['$a_4$'], findings: ['$a_5$'], limitations: ['$a_6$'], keywords: [],
    model: { provider: 'deepseek' as const, name: 'deepseek-flash' }, generatedAt: '2026-10-14T00:00:00Z', sourceRevision: 'fixture'
  }
  const source: PaperInsightSource = {
    get: async () => ({ status: 'ready', insight, stale: true }),
    generate: async () => undefined, subscribe: () => () => undefined
  }
  const original = JSON.stringify(insight)
  const onOpen = vi.fn()
  const view = render(<ArchiveDetail paper={{ id: '00000000-0000-4000-8000-000000000001', displayName: 'Paper.pdf', originalName: 'Paper.pdf', createdAt: '2026-10-14T00:00:00Z', workflow: { status: 'completed', progress: 100, activeJobKind: null, error: null } }} category="测试" fileNumber={1} phase="open" onPage={vi.fn()} onClose={vi.fn()} onOpen={onOpen} insights={source} />)
  fireEvent.click(await screen.findByRole('tab', { name: /AI 解读/u }))
  await vi.waitFor(() => expect(view.container.querySelectorAll('.paper-archive-insight .katex')).toHaveLength(6))
  expect(view.container.textContent).toContain('论文内容已更新')
  expect(view.container.querySelector('p p, dd p, li p')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /打开阅读/u }))
  expect(onOpen).toHaveBeenCalledOnce()
  expect(JSON.stringify(insight)).toBe(original)
})

it('shows generated abstract, paper background, core work and discussion on four tabs', async () => {
  const parsed = parseBriefResponse(JSON.stringify(briefGeneration), { requireAnalysis: true })
  if (!parsed.ok) throw Error(parsed.problems.join('; '))
  const context = buildFullBriefContext('# Paper\n\nOriginal evidence.', '')
  const brief = assembleBrief(parsed.content, context, { provider: 'codex', model: 'test', sourceRevision: 'test' })
  const source: PaperInsightSource = {
    get: async () => ({ status: 'ready', brief, anchors: [{ id: 'E1', section: 'Paper', text: 'Original evidence.' }], stale: false, promptOutdated: false }),
    generate: async () => undefined, subscribe: () => () => undefined
  }
  const view = render(<ArchiveDetail paper={{ id: '00000000-0000-4000-8000-000000000001', displayName: 'Paper.pdf', originalName: 'Paper.pdf', createdAt: '2026-10-15T00:00:00Z', workflow: { status: 'completed', progress: 100, activeJobKind: null, error: null } }} category="测试" fileNumber={1} phase="open" onPage={vi.fn()} onClose={vi.fn()} onOpen={vi.fn()} insights={source} />)
  await screen.findByRole('tab', { name: /讨论/u })
  expect(screen.getAllByRole('tab')).toHaveLength(4)
  expect(screen.getByRole('tabpanel').textContent).toContain(briefGeneration.analysis.abstract)
  fireEvent.click(screen.getByRole('tab', { name: /背景/u }))
  expect(view.container.querySelectorAll('.paper-archive-reading-points > li')).toHaveLength(3)
  fireEvent.click(screen.getByRole('tab', { name: /结论/u }))
  expect(view.container.querySelectorAll('.paper-archive-reading-points > li')).toHaveLength(3)
  fireEvent.click(screen.getAllByText(/原文依据/u)[0]!)
  expect(view.container.textContent).toContain('Original evidence.')
  fireEvent.click(screen.getByRole('tab', { name: /讨论/u }))
  expect(screen.getByRole('tabpanel').textContent).toContain(briefGeneration.analysis.discussion.progress)
  expect(view.container.textContent).not.toMatch(/研究进展以论文所述范围为准|依据提供的全文生成|全文已提供，部分证据仍缺失/u)
  expect(view.container.querySelector('p p, h3 p, h4 p')).toBeNull()
})

it('uses saved model authors only when the local byline is missing and the source is fresh', async () => {
  const markdown = '# Paper\n\n## Authors\n\nalice smith; bob jones\n\n## Abstract\n\nOriginal evidence.'
  query.data = { markdown, translatedMarkdown: '', summary: { updatedAt: 'test' } }
  const parsed = parseBriefResponse(JSON.stringify({ ...briefGeneration, metadata: { ...briefGeneration.metadata,
    authors: { value: 'alice smith; bob jones', evidence: 'alice smith; bob jones', anchors: ['E1'] } } }), { requireAnalysis: true })
  if (!parsed.ok) throw Error(parsed.problems.join(';'))
  const brief = assembleBrief(parsed.content, buildFullBriefContext(markdown, ''), { provider: 'codex', model: 'test', sourceRevision: 'test' })
  const renderSource = (stale: boolean) => {
    const source: PaperInsightSource = { get: async () => ({ status: 'ready', brief, anchors: [], stale, promptOutdated: false }),
      generate: async () => undefined, subscribe: () => () => undefined }
    return render(<ArchiveDetail paper={{ id: '00000000-0000-4000-8000-000000000001', displayName: 'Paper.pdf', originalName: 'Paper.pdf', createdAt: '2026-10-16T00:00:00Z', workflow: { status: 'completed', progress: 100, activeJobKind: null, error: null } }} category="测试" fileNumber={1} phase="open" onPage={vi.fn()} onClose={vi.fn()} onOpen={vi.fn()} insights={source} />)
  }
  let view = renderSource(false)
  await vi.waitFor(() => expect(view.container.querySelector('.paper-archive-fields dd')?.textContent).toBe('alice smith; bob jones'))
  view.unmount()
  query.data = { ...query.data, markdown: '# Paper\n\nCorrect Local Name\n\n## Abstract\n\nText.' }
  view = renderSource(false)
  await vi.waitFor(() => expect(view.container.querySelector('.paper-archive-fields dd')?.textContent).toBe('Correct Local Name'))
  view.unmount()
  query.data = { ...query.data, markdown }
  view = renderSource(true)
  await screen.findByRole('tab', { name: /讨论/u })
  expect(view.container.querySelector('.paper-archive-fields dd')?.textContent).toBe('未识别')
})
