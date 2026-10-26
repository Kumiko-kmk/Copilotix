// The extracted card shows a spread: the paper's first page on the left, its key figures on a
// sheet of the same size on the right. Figures come from the paper's figures.json; their order
// follows the figure AI interpretation's displayWeight when present (docs/FIGURE_INSIGHT_ZH.md),
// otherwise a heuristic from the figures themselves.

export interface SpreadCandidate {
  figureId: string
  imagePath: string
  /** Width / height of the stored PNG. */
  aspect: number
  /** 0–1 display priority; the highest-ranked candidate comes first. */
  weight: number
}

export interface SpreadPlacement { figureId: string; x: number; y: number; width: number; height: number }

interface Box { width: number; height: number }

/** Inner margins and gaps of the figure sheet, as fractions of its width. */
const MARGIN_X = 0.085
const MARGIN_Y = 0.075
const GAP = 0.035
/** A figure whose shorter side is below this share of the sheet is unreadable on the card. */
const MIN_SIDE = 0.24
/** More figures are welcome while they keep a readable size; this caps the search, not the taste. */
const MAX_FIGURES = 6
const MAX_ROW = 3

/**
 * Arrange ranked figures in justified rows (every figure in a row shares its height and the row
 * spans the sheet). Tries the top 1–6 figures in every split into rows of 1–3, in rank order, and
 * keeps the arrangement that uses the most of the sheet without shrinking any figure below a
 * readable size; between similar arrangements, the one showing more important figures wins.
 * Placements are in the sheet's pixels.
 */
export function layoutSpreadFigures(candidates: readonly SpreadCandidate[], sheet: Box): SpreadPlacement[] {
  const inner = { x: sheet.width * MARGIN_X, y: sheet.width * MARGIN_Y }
  const box = { width: sheet.width - inner.x * 2, height: sheet.height - inner.y * 2 }
  const gap = sheet.width * GAP
  const pool = candidates.slice(0, MAX_FIGURES)
  let best: { score: number; placements: SpreadPlacement[] } | null = null
  for (let count = 1; count <= pool.length; count++) {
    const chosen = pool.slice(0, count)
    for (const rows of splits(count)) {
      const placements = justify(chosen, rows, box, gap)
      if (!placements) continue
      const score = scoreLayout(chosen, placements, box)
      if (!best || score > best.score) best = { score, placements }
    }
  }
  return (best?.placements ?? []).map((placement) => ({ ...placement, x: placement.x + inner.x, y: placement.y + inner.y }))
}

/** Every way to cut `count` figures, in order, into rows of 1–3. */
function splits(count: number): number[][] {
  if (count === 0) return [[]]
  const result: number[][] = []
  for (let first = 1; first <= Math.min(MAX_ROW, count); first++) {
    for (const rest of splits(count - first)) result.push([first, ...rest])
  }
  return result
}

function justify(figures: readonly SpreadCandidate[], rows: readonly number[], box: Box, gap: number): SpreadPlacement[] | null {
  let index = 0
  const lines = rows.map((size) => {
    const members = figures.slice(index, index += size)
    const aspects = members.reduce((sum, figure) => sum + figure.aspect, 0)
    return { members, height: (box.width - gap * (size - 1)) / aspects }
  })
  const gaps = gap * (lines.length - 1)
  const natural = lines.reduce((sum, line) => sum + line.height, 0)
  // Too tall: scale every row down together and centre them; otherwise centre the block vertically.
  const scale = Math.min(1, (box.height - gaps) / natural)
  if (scale <= 0) return null
  const used = natural * scale + gaps
  let y = (box.height - used) / 2
  const placements: SpreadPlacement[] = []
  for (const line of lines) {
    const height = line.height * scale
    const width = line.members.reduce((sum, figure) => sum + figure.aspect * height, 0) + gap * (line.members.length - 1)
    let x = (box.width - width) / 2
    for (const figure of line.members) {
      placements.push({ figureId: figure.figureId, x, y, width: figure.aspect * height, height })
      x += figure.aspect * height + gap
    }
    y += height + gap
  }
  if (placements.some((placement) => Math.min(placement.width, placement.height) < box.width * MIN_SIDE)) return null
  return placements
}

function scoreLayout(figures: readonly SpreadCandidate[], placements: readonly SpreadPlacement[], box: Box): number {
  const areas = placements.map((placement) => placement.width * placement.height)
  const coverage = areas.reduce((sum, area) => sum + area, 0) / (box.width * box.height)
  const top = figures[0]!.weight || 1
  // Each further figure is worth including in proportion to how important it is.
  const richness = figures.slice(1).reduce((sum, figure) => sum + 0.05 * Math.min(1, figure.weight / top), 0)
  // The most important figure should not end up the smallest one.
  const hierarchy = areas[0]! >= Math.max(...areas) * 0.8 ? 0.03 : 0
  // One huge figure beside thumbnails reads as clutter: keep the smallest within reach of the largest.
  const disparity = Math.max(0, 0.18 - Math.min(...areas) / Math.max(...areas)) / 0.18 * 0.2
  return coverage + richness + hierarchy - disparity
}

interface ManifestFigure { figureId: string; imagePath: string; width: number; height: number; pageIndex: number; cropBox: number[] }

/** Read the paper's figure manifest; anything malformed is skipped rather than trusted. */
export function parseFigureManifest(value: unknown): ManifestFigure[] {
  const figures = (value as { figures?: unknown } | null)?.figures
  if (!Array.isArray(figures)) return []
  return figures.filter((figure): figure is ManifestFigure => {
    const item = figure as Partial<ManifestFigure> | null
    return Boolean(item && typeof item.figureId === 'string' && typeof item.imagePath === 'string'
      && /^images\/figures\/[\w.-]+\.png$/u.test(item.imagePath)
      && Number.isFinite(item.width) && item.width! > 0 && Number.isFinite(item.height) && item.height! > 0
      && Number.isInteger(item.pageIndex) && Array.isArray(item.cropBox) && item.cropBox.length === 4)
  })
}

/**
 * Rank figures for the cover. Figures on the first page are already visible on the left sheet.
 * A figure the AI interpretation scored comes first by that score; a zero score (formulas,
 * unreadable) never shows. Unscored figures follow, ranked by how early they appear (overview and
 * method figures lead papers, appendices trail), how much of the page they take and whether their
 * shape suits a cover.
 */
export function rankSpreadFigures(figures: readonly ManifestFigure[], weights: ReadonlyMap<string, number>): SpreadCandidate[] {
  const area = (figure: ManifestFigure): number => Math.abs((figure.cropBox[2]! - figure.cropBox[0]!) * (figure.cropBox[3]! - figure.cropBox[1]!))
  const largest = Math.max(1, ...figures.map(area))
  const lastPage = Math.max(1, ...figures.map((figure) => figure.pageIndex))
  const heuristic = (figure: ManifestFigure): number => {
    const aspect = figure.width / figure.height
    const shape = aspect < 0.5 ? aspect / 0.5 : aspect > 4 ? 4 / aspect : 1
    return 0.4 * area(figure) / largest + 0.4 * (1 - figure.pageIndex / lastPage) + 0.2 * shape
  }
  const usable = figures.filter((figure) => {
    const aspect = figure.width / figure.height
    return figure.pageIndex > 0 && aspect >= 0.3 && aspect <= 5.5 && weights.get(figure.figureId) !== 0
  })
  const scored = usable.map((figure) => {
    const weight = weights.get(figure.figureId)
    return { figure, rank: weight === undefined ? heuristic(figure) : 1 + weight / 100, weight: weight === undefined ? heuristic(figure) : weight / 100 }
  })
  scored.sort((a, b) => b.rank - a.rank)
  return scored.map(({ figure, weight }) => ({ figureId: figure.figureId, imagePath: figure.imagePath, aspect: figure.width / figure.height, weight }))
}

/** The paper's ranked cover candidates: its figure manifest and the interpretation scores. */
export async function loadSpreadCandidates(documentId: string, assetBaseUrl: string): Promise<SpreadCandidate[]> {
  const response = await fetch(`${assetBaseUrl}figures.json`)
  if (!response.ok) return []
  const figures = parseFigureManifest(await response.json())
  if (!figures.length) return []
  const insight = window.copilotix?.figureInsight
  const weights = new Map<string, number>()
  if (insight) {
    const states = await Promise.all(figures.map((figure) => insight.get({ documentId, figureId: figure.figureId }).catch(() => null)))
    states.forEach((state, index) => {
      if (state?.status === 'ready') weights.set(figures[index]!.figureId, state.record.content.displayWeight)
    })
  }
  return rankSpreadFigures(figures, weights)
}

export type PlacedFigure = SpreadPlacement & { image: ImageBitmap }

/** Lay the candidates out on a sheet and decode only the placed images, at their drawn size. */
export async function loadSpreadImages(candidates: readonly SpreadCandidate[], assetBaseUrl: string, sheet: Box): Promise<PlacedFigure[]> {
  const placements = layoutSpreadFigures(candidates, sheet)
  const byId = new Map(candidates.map((candidate) => [candidate.figureId, candidate]))
  const loaded = await Promise.all(placements.map(async (placement) => {
    try {
      const image = await fetch(`${assetBaseUrl}${byId.get(placement.figureId)!.imagePath}`)
      if (!image.ok) return null
      const bitmap = await createImageBitmap(await image.blob(), { resizeWidth: Math.max(1, Math.round(placement.width)), resizeQuality: 'high' })
      return { ...placement, image: bitmap }
    } catch {
      return null
    }
  }))
  // A figure that failed to load would leave a hole; then the cover keeps the plain first page.
  if (loaded.some((entry) => !entry)) {
    loaded.forEach((entry) => entry?.image.close())
    return []
  }
  return loaded as PlacedFigure[]
}

/** The key figures on a white sheet the size of the first page. */
export function drawFigureSheet(width: number, height: number, figures: readonly PlacedFigure[]): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { alpha: false })
  if (!context) return canvas
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, width, height)
  context.imageSmoothingQuality = 'high'
  for (const figure of figures) {
    context.drawImage(figure.image, figure.x, figure.y, figure.width, figure.height)
    context.strokeStyle = 'rgba(47, 42, 36, 0.14)'
    context.lineWidth = 2
    context.strokeRect(figure.x - 1, figure.y - 1, figure.width + 2, figure.height + 2)
    figure.image.close()
  }
  return canvas
}

/** The first page and the figure sheet side by side, as one canvas the card can show. */
export function composeSpread(page: HTMLCanvasElement, sheet: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = page.width * 2
  canvas.height = page.height
  const context = canvas.getContext('2d', { alpha: false })
  if (!context) return page
  context.drawImage(page, 0, 0)
  context.drawImage(sheet, page.width, 0, page.width, page.height)
  // The fold between the two sheets: a soft shade either side of a hairline.
  const fold = context.createLinearGradient(page.width - 28, 0, page.width + 28, 0)
  fold.addColorStop(0, 'rgba(60, 48, 32, 0)')
  fold.addColorStop(0.5, 'rgba(60, 48, 32, 0.10)')
  fold.addColorStop(1, 'rgba(60, 48, 32, 0)')
  context.fillStyle = fold
  context.fillRect(page.width - 28, 0, 56, canvas.height)
  canvas.dataset.archiveCover = 'spread'
  return canvas
}
