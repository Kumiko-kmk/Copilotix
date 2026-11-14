import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentDetails } from '@features/library/contract/documentSchemas'
import type { ReaderFigureGeometry } from '@features/reader/core'
import type { ArchivePaper } from '../../../src/features/library/renderer/archive/archiveShelves'

const mocked = vi.hoisted(() => ({ coverSource: vi.fn(), build: vi.fn(), ensure: vi.fn(), page: { width: 0, height: 0 } }))
vi.mock('../../../src/features/library/renderer/archive/detailPage', () => ({
  firstPageRenderer: () => async () => ({ canvas: mocked.page, pages: 1 }),
  drawTextPage: () => ({ canvas: { width: 700, height: 1000 }, pages: null })
}))
vi.mock('../../../src/features/library/renderer/archive/archiveBrowseData', () => ({ archivePaperRevision: () => 'rev', loadArchiveDocument: vi.fn() }))
vi.mock('@features/reader/core', () => ({ buildReaderFigureGeometries: mocked.build }))
vi.mock('@features/reader/renderer', () => ({ loadFigureArtifacts: async () => ({ ensureFigureArtifacts: mocked.ensure }) }))
import { renderArchiveCover } from '../../../src/features/library/renderer/archive/archiveCover'

const paper = { id: 'paper', originalName: 'paper.pdf', displayName: 'Paper', sourceHash: 'hash', createdAt: 'now',
  workflow: { status: 'completed', progress: 100, activeJobKind: null, error: null } } as ArchivePaper
const hint = (status: ReaderFigureGeometry['status']) => ({ id: `figure-${status}`, pageIndex: 2, cropBox: [0, 0, 100, 100],
  pageSize: [600, 800], mappingIds: [], assetSources: [], captionMappingId: 'caption', fallbackLegendText: '', status, reason: '', members: [] }) as ReaderFigureGeometry
const details = (figures: ReaderFigureGeometry[], base: boolean) => ({ summary: { sourceHash: 'hash' }, pdfUrl: 'copilotix://paper.pdf',
  assetBaseUrl: 'copilotix://paper/', markdown: '', mappings: [], layoutJson: null, ...(base ? { base: { figures } } : {}) }) as unknown as DocumentDetails

beforeEach(() => {
  vi.resetAllMocks()
  mocked.page = { width: 600, height: 800 }
  // No saved figures.json: nothing was ever cropped for this paper.
  mocked.coverSource.mockResolvedValue({ fingerprint: 'no-manifest', hasManifest: false, figures: [] })
  mocked.build.mockReturnValue([])
  // The crop pipeline only exports complete groups, so these hints never produce a crop.
  mocked.ensure.mockResolvedValue({ available: 0, failed: 0 })
  vi.stubGlobal('window', { copilotix: { figureInsight: { coverSource: mocked.coverSource } } })
})
afterEach(() => { vi.unstubAllGlobals() })

describe('archive cover threshold', () => {
  for (const status of ['ambiguous', 'unsupported'] as const) {
    for (const base of [true, false]) {
      it(`refuses to open a paper whose only figure hints are ${status} (${base ? 'document model' : 'legacy layout'})`, async () => {
        const figures = [hint(status)]
        mocked.build.mockReturnValue(figures)
        const result = renderArchiveCover(paper, details(figures, base), new AbortController().signal)
        // A single-page fallback here would let the scene open a paper whose figures are not ready.
        await expect(result).rejects.toThrow('封面整圖清單尚未準備完整')
        expect(mocked.ensure).toHaveBeenCalledOnce()
        expect(mocked.page.width).toBe(0)
      })
    }
  }

  it('keeps refusing when complete groups sit beside ambiguous ones and none was cropped', async () => {
    const figures = [hint('ambiguous'), hint('complete')]
    mocked.ensure.mockResolvedValue({ available: 0, failed: 1 })
    await expect(renderArchiveCover(paper, details(figures, true), new AbortController().signal)).rejects.toThrow('封面整圖尚未準備完整')
  })

  it('still uses a single page when the paper has no figure hints at all', async () => {
    const cover = await renderArchiveCover(paper, details([], true), new AbortController().signal)
    expect(cover.kind).toBe('single')
    expect(cover.canvas).toBe(mocked.page)
    expect(mocked.ensure).not.toHaveBeenCalled()
  })
})
