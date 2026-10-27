import type { ArchiveCoverSource } from '@features/insight/contract/figureInsight'
import type { DocumentDetails } from '../../contract/documentSchemas'
import { archivePaperRevision, loadArchiveDocument } from './archiveBrowseData'
import type { ArchivePaper } from './archiveShelves'
import { composeSpread, drawFigureSheet, loadSpreadImages, parseFigureManifest, rankSpreadFigures } from './figureSpread'
import type { ArchiveCoverKind } from './archiveCoverStore'

export interface RenderedArchiveCover { canvas: HTMLCanvasElement; kind: ArchiveCoverKind; fingerprint: string }

/** Production reads one compact descriptor; older embedded fixtures can still use their local manifest. */
export async function readArchiveCoverSource(paper: ArchivePaper, signal: AbortSignal, data?: DocumentDetails): Promise<ArchiveCoverSource> {
  signal.throwIfAborted()
  const insight = window.copilotix?.figureInsight
  if (insight?.coverSource) {
    const source = await insight.coverSource({ documentId: paper.id })
    signal.throwIfAborted()
    return source
  }
  const details = data ?? await loadArchiveDocument(paper.id, archivePaperRevision(paper))
  const response = await fetch(`${details.assetBaseUrl}figures.json`, { signal })
  if (!response.ok) throw new Error('无法读取封面整图清单')
  const json: unknown = await response.json()
  if (!Array.isArray((json as { figures?: unknown } | null)?.figures)) throw new Error('封面整图清单无效')
  const figures = parseFigureManifest(json)
  const states = insight ? await Promise.all(figures.map(figure => insight.get({ documentId: paper.id, figureId: figure.figureId }))) : []
  signal.throwIfAborted()
  const weighted = figures.map((figure, index) => {
    const state = states[index]
    return { ...figure, cropBox: figure.cropBox as [number, number, number, number],
      ...(state?.status === 'ready' && !state.stale ? { displayWeight: state.record.content.displayWeight } : {}) }
  })
  const bytes = new TextEncoder().encode(JSON.stringify(weighted))
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return { fingerprint: Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join(''), hasManifest: true, figures: weighted }
}

function clear(canvas: HTMLCanvasElement | undefined): void { if (canvas) { canvas.width = 0; canvas.height = 0 } }

/** Build and return only the final cover; page and figure-sheet scratch canvases never enter a cache. */
export async function renderArchiveCover(paper: ArchivePaper, data: DocumentDetails, signal: AbortSignal, initialSource?: ArchiveCoverSource): Promise<RenderedArchiveCover> {
  const { firstPageRenderer, drawTextPage } = await import('./detailPage')
  signal.throwIfAborted()
  if (/\.(?:md|markdown)$/iu.test(paper.originalName)) {
    const [{ extractPaperProfile }, source] = await Promise.all([import('../../core/paperProfile'), readArchiveCoverSource(paper, signal, data)])
    const profile = extractPaperProfile(data.markdown, data.translatedMarkdown, true)
    return { canvas: drawTextPage(profile.title ?? paper.displayName, profile.translatedAbstract ?? profile.abstract).canvas, kind: 'single', fingerprint: source.fingerprint }
  }
  const [{ buildReaderFigureGeometries }, { loadFigureArtifacts }] = await Promise.all([
    import('@features/reader/core'), import('@features/reader/renderer')
  ])
  signal.throwIfAborted()
  // The crop pipeline exports only complete groups. Ambiguous/unsupported
  // hints cannot produce a manifest and must not lock a valid single-page cover.
  const geometries = buildReaderFigureGeometries(data.mappings, data.layoutJson).filter(figure => figure.status === 'complete')
  // Only the PDF renderer owns its temporary page canvas. It is cleared even when crop work fails.
  const page = await firstPageRenderer(data.summary.sourceHash)(data.pdfUrl)
  let sheet: HTMLCanvasElement | undefined
  let final: HTMLCanvasElement | undefined
  try {
    signal.throwIfAborted()
    let source = initialSource ?? await readArchiveCoverSource(paper, signal, data)
    const rank = (value: ArchiveCoverSource) => rankSpreadFigures(value.figures,
      new Map(value.figures.flatMap(figure => figure.displayWeight === undefined ? [] : [[figure.figureId, figure.displayWeight] as const])))
    let ranked = rank(source)
    if (!ranked.length && (!geometries.length || source.hasManifest && source.figures.length > 0)) {
      final = page.canvas
      return { canvas: final, kind: 'single', fingerprint: source.fingerprint }
    }
    // A valid saved manifest and readable selected PNGs need no per-figure existence/crop sweep.
    let figures = source.hasManifest && ranked.length ? await loadSpreadImages(ranked, data.assetBaseUrl, page.canvas) : []
    if (!figures.length) {
      const { ensureFigureArtifacts } = await loadFigureArtifacts()
      const crops = await ensureFigureArtifacts(paper.id, data.pdfUrl, geometries, signal)
      signal.throwIfAborted()
      if (crops.failed) throw new Error('封面整图尚未准备完整')
      // Materialising figures can change the descriptor: store the actual final fingerprint.
      source = await readArchiveCoverSource(paper, signal, data)
      if (geometries.length && (!source.hasManifest || !source.figures.length)) throw new Error('封面整图清单尚未准备完整')
      ranked = rank(source)
      if (!ranked.length) {
        final = page.canvas
        return { canvas: final, kind: 'single', fingerprint: source.fingerprint }
      }
      figures = await loadSpreadImages(ranked, data.assetBaseUrl, page.canvas)
    }
    if (signal.aborted) { figures.forEach(figure => figure.image.close()); signal.throwIfAborted() }
    if (!figures.length) throw new Error('无法读取封面整图')
    try { sheet = drawFigureSheet(page.canvas.width, page.canvas.height, figures) }
    catch (error) { figures.forEach(figure => figure.image.close()); throw error }
    if (!sheet.getContext('2d')) { figures.forEach(figure => figure.image.close()); throw new Error('无法绘制封面整图页') }
    final = composeSpread(page.canvas, sheet)
    if (final === page.canvas || final.width !== page.canvas.width * 2) { final = undefined; throw new Error('无法合成完整跨页封面') }
    signal.throwIfAborted()
    return { canvas: final, kind: 'spread', fingerprint: source.fingerprint }
  } catch (error) {
    if (final !== page.canvas) clear(final)
    final = undefined
    throw error
  } finally {
    if (final !== page.canvas) clear(page.canvas)
    clear(sheet)
  }
}
