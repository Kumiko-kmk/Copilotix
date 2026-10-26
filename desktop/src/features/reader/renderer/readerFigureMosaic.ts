import { figureAssetName, type FigureBox, type ReaderFigureGroup } from '../core/readerFigureGroups'

/**
 * A figure the reader cannot crop from the PDF (no confirmed caption or boundary, or a failed
 * crop) still keeps its panels where the PDF puts them: side-by-side panels are drawn as a mosaic
 * of the parsed images at their page positions, instead of one image per line.
 */
export interface MosaicTile {
  sourceAsset: string
  /** The path to load: the Markdown's own path when one of the figure's paragraphs holds the panel. */
  src: string
  /** Position and size as fractions of the mosaic. */
  left: number
  top: number
  width: number
  height: number
}

export interface FigureMosaic {
  tiles: MosaicTile[]
  /** Width over height of the panels' union. */
  aspect: number
  /** Share of the page width the panels span, so a narrow figure is not blown up. */
  pageShare: number
}

/** Two panels sit side by side when they share most of their height and not their width. */
function sideBySide(a: FigureBox, b: FigureBox): boolean {
  const vertical = Math.min(a[3], b[3]) - Math.max(a[1], b[1])
  const horizontal = Math.min(a[2], b[2]) - Math.max(a[0], b[0])
  return vertical >= 0.4 * Math.min(a[3] - a[1], b[3] - b[1]) && horizontal <= 0.1 * Math.min(a[2] - a[0], b[2] - b[0])
}

export function figureMosaic(group: Pick<ReaderFigureGroup, 'members' | 'pageSize'>, markdownSources: readonly string[] = []): FigureMosaic | null {
  const seen = new Set<string>()
  const panels = group.members.filter(member => {
    if (member.kind !== 'asset' || !member.sourceAsset) return false
    const name = figureAssetName(member.sourceAsset)
    if (seen.has(name)) return false
    seen.add(name)
    return true
  })
  if (panels.length < 2 || !panels.some((a, i) => panels.some((b, j) => i !== j && sideBySide(a.bbox, b.bbox)))) return null
  const x0 = Math.min(...panels.map(p => p.bbox[0])), y0 = Math.min(...panels.map(p => p.bbox[1]))
  const x1 = Math.max(...panels.map(p => p.bbox[2])), y1 = Math.max(...panels.map(p => p.bbox[3]))
  const width = x1 - x0, height = y1 - y0
  if (width <= 0 || height <= 0) return null
  return {
    aspect: width / height,
    pageShare: Math.min(1, width / Math.max(1, group.pageSize[0])),
    tiles: panels.map(panel => ({
      sourceAsset: panel.sourceAsset!,
      // Layouts may keep only the file name; the Markdown keeps the images/ path.
      src: markdownSources.find(source => figureAssetName(source) === figureAssetName(panel.sourceAsset!)) ??
        (/[\\/]/u.test(panel.sourceAsset!) ? panel.sourceAsset! : 'images/' + panel.sourceAsset!),
      left: (panel.bbox[0] - x0) / width,
      top: (panel.bbox[1] - y0) / height,
      width: (panel.bbox[2] - panel.bbox[0]) / width,
      height: (panel.bbox[3] - panel.bbox[1]) / height
    }))
  }
}
