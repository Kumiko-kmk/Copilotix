import type { ReaderBlock } from './readerDocument'
import type { BlockMapping } from '@features/parsing/contract/blocks'
import { readFigureLayoutHints, type FigureBox, type FigureLayoutHint } from './readerFigureLayout'
import { unified } from 'unified'
import remarkParse from 'remark-parse'

export type { FigureBox }
export type FigureStatus = 'complete' | 'ambiguous' | 'unsupported'
export interface FigureMember {
  mappingId?: string
  blockPosition?: string
  bbox: FigureBox
  sourceAsset?: string
  sourceText: string
  kind: 'asset' | 'supporting'
}
export interface ReaderFigureGeometry {
  id: string
  pageIndex: number
  cropBox: FigureBox
  pageSize: [number, number]
  mappingIds: string[]
  assetSources: string[]
  captionMappingId: string
  captionLabel?: string
  captionBlockPosition?: string
  fallbackLegendText: string
  status: FigureStatus
  reason: string
  members: FigureMember[]
}
export interface ReaderFigureGroup extends ReaderFigureGeometry {
  ownerBlockIndex: number
  captionBlockIndex: number
  memberBlockIndexes: number[]
  captionMarkdown: string
  supportingTextsByBlock?: Record<number, string[]>
  /** Set by the reader when a display choice may apply (renderer/readerFigureDisplay.ts). */
  display?: { documentId: string; automatic: FigureStatus; choice: 'pdf' | 'parsed' | null }
}
interface Entry {
  key: string
  mapping: BlockMapping
  bbox: FigureBox
  pageSize: [number, number]
  parents: FigureLayoutHint[]
  blockPosition?: string
}

const ASSETS = new Set(['image', 'chart', 'image_body', 'chart_body'])
const CAPTIONS = new Set(['image_caption', 'chart_caption'])
const FOOTNOTES = new Set(['image_footnote', 'chart_footnote'])
const HEADERS = /^(?:header|footer|page_header|page_footer|page_number|page_num|page_count)$/u
const FIGURE_PREFIX = /^\s*(?:(?:supplementary|extended\s+data)\s+)?(?:fig(?:ure)?\.?|[附補补]?圖|[附补]?图)\s*((?:[A-Z]\.?\s*)?\d+[A-Z]?)(?:\b|(?=[：:．.、\s]))/iu
function captionLabel(markdown: string): string | undefined {
  return FIGURE_PREFIX.exec(captionFromMarkdown(markdown))?.[1]?.replace(/[.\s]/gu, '').toUpperCase()
}
const LABEL = /^\s*(?:[（(]\s*[a-zA-Z一二三四五六七八九十]+\s*[)）]|[A-Z])\s*[.。]?\s*$/u
/** A sub-panel caption such as "(a) ground truth"; parsers type it as image, chart, table caption or text. */
const PANEL_CAPTION = /^\s*[（(]\s*[a-z]{1,2}\d?\s*[)）]\s*\S.{0,90}$/iu

export function figureAssetName(value: string): string {
  try { value = decodeURIComponent(value) } catch { /* Retain malformed paths for comparison. */ }
  return value.replace(/\\/gu, '/').split(/[?#]/u)[0]!.split('/').pop()!.toLocaleLowerCase('en-US')
}
export function isFigureLabel(value: string): boolean { return LABEL.test(value.trim()) }
function type(entry: Entry): string { return entry.mapping.type.trim().toLowerCase().replace(/[\s-]+/gu, '_') }
function isCaption(entry: Entry): boolean {
  if (!FIGURE_PREFIX.test(entry.mapping.sourceText)) return false
  if (CAPTIONS.has(type(entry))) return true
  // A body sentence such as "Figure 2 shows..." is not a figure caption.
  return type(entry) === 'text' && (entry.parents.some(parent => parent.captionTexts.includes(entry.mapping.sourceText.trim())) ||
    // Nature-style captions separate the number with a bar: "Figure 3 | From image to text".
    /^[^:：]*\d+[A-Z]?\s*[.:：．、|｜]/iu.test(entry.mapping.sourceText))
}
function isAsset(entry: Entry): boolean { return ASSETS.has(type(entry)) }
/** "Fig. 6 | Results…": Nature-style captions run the full figure width below (or beside) it. */
const BAR_CAPTION = /^\s*(?:fig(?:ure)?\.?|[附補补]?圖|[附补]?图)\s*\d+[A-Z]?\s*[|｜]/iu
/**
 * Panels whose bottom edge sits right on top of a bar caption form the figure's last row. Such a
 * caption is left-aligned and often shorter than the figure, so on its own it cannot separate a
 * right-hand panel column from the next figure below. Widen it to the row it closes.
 */
function barCaptionRow(caption: Entry, assets: readonly Entry[]): Entry[] {
  if (!BAR_CAPTION.test(caption.mapping.sourceText)) return []
  const gap = Math.max(12, caption.pageSize[1] * 0.03)
  const row = assets.filter(asset => asset.bbox[3] <= caption.bbox[1] + 2 && caption.bbox[1] - asset.bbox[3] <= gap)
  return row.some(asset => Math.min(asset.bbox[2], caption.bbox[2]) > Math.max(asset.bbox[0], caption.bbox[0])) ? row : []
}
function overlap(a: FigureBox, b: FigureBox): boolean {
  return Math.min(a[2], b[2]) > Math.max(a[0], b[0]) && Math.min(a[3], b[3]) > Math.max(a[1], b[1])
}
function union(boxes: readonly FigureBox[]): FigureBox {
  return [Math.min(...boxes.map(b => b[0])), Math.min(...boxes.map(b => b[1])),
    Math.max(...boxes.map(b => b[2])), Math.max(...boxes.map(b => b[3]))]
}
function padded(box: FigureBox, size: [number, number], x = 4, y = x): FigureBox {
  return [Math.max(0, box[0] - x), Math.max(0, box[1] - y), Math.min(size[0], box[2] + x), Math.min(size[1], box[3] + y)]
}
/** Keep every source pixel; only trim optional padding where neighbouring content is close. */
function paddedWithinWhitespace(box: FigureBox, size: [number, number], neighbours: readonly Entry[]): FigureBox {
  const requested = padded(box, size)
  const crop: FigureBox = [...requested]
  for (const { bbox: other } of neighbours) {
    if (!overlap(requested, other) || overlap(box, other)) continue
    if (other[2] <= box[0]) crop[0] = Math.max(crop[0], (other[2] + box[0]) / 2)
    if (other[0] >= box[2]) crop[2] = Math.min(crop[2], (other[0] + box[2]) / 2)
    if (other[3] <= box[1]) crop[1] = Math.max(crop[1], (other[3] + box[1]) / 2)
    if (other[1] >= box[3]) crop[3] = Math.min(crop[3], (other[1] + box[3]) / 2)
  }
  return crop
}
function gaps(a: FigureBox, b: FigureBox): [number, number] {
  return [Math.max(0, a[0] - b[2], b[0] - a[2]), Math.max(0, a[1] - b[3], b[1] - a[3])]
}
function distance(a: Entry, b: Entry): number {
  const [x, y] = gaps(a.bbox, b.bbox)
  return Math.hypot(x / a.pageSize[0], y / a.pageSize[1])
}
function relatedParent(a: Entry, b: Entry): boolean {
  return a.parents.some(p => b.parents.includes(p))
}
/** Page-normalised geometry plus panel scale: tolerate sparse rows without bridging prose. */
function adjacent(a: Entry, b: Entry): boolean {
  if (relatedParent(a, b)) return true
  const [x, y] = gaps(a.bbox, b.bbox)
  const width = Math.min(a.bbox[2] - a.bbox[0], b.bbox[2] - b.bbox[0])
  const height = Math.min(a.bbox[3] - a.bbox[1], b.bbox[3] - b.bbox[1])
  const horizontal = Math.min(a.bbox[2], b.bbox[2]) - Math.max(a.bbox[0], b.bbox[0])
  const vertical = Math.min(a.bbox[3], b.bbox[3]) - Math.max(a.bbox[1], b.bbox[1])
  const baseX = Math.max(12, a.pageSize[0] * 0.04), baseY = Math.max(12, a.pageSize[1] * 0.04)
  return (x <= baseX && y <= baseY) ||
    (horizontal >= width * 0.5 && y <= Math.max(baseY, height * 0.6)) ||
    (vertical >= height * 0.5 && x <= Math.max(baseX, width * 0.6))
}
function alignment(asset: Entry, caption: Entry): number {
  const a = asset.bbox, c = caption.bbox
  const x = Math.max(0, Math.min(a[2], c[2]) - Math.max(a[0], c[0])) / (a[2] - a[0])
  const y = Math.max(0, Math.min(a[3], c[3]) - Math.max(a[1], c[1])) / (a[3] - a[1])
  return Math.max(x, y)
}
function captionSide(asset: Entry, caption: Entry): string {
  const a = asset.bbox, c = caption.bbox
  return a[3] <= c[1] ? 'above' : a[1] >= c[3] ? 'below' : a[2] <= c[0] ? 'left' : a[0] >= c[2] ? 'right' : 'overlap'
}
interface Proposal {
  caption?: Entry
  captionBoxes?: Entry[]
  members: Entry[]
  status: FigureStatus
  reason: string
}
/** Multi-source shortest paths give each panel an owner before any rectangular crop is made. */
function assignOwners(nodes: Entry[], adjacency: Map<Entry, Entry[]>, seeds: Map<Entry, number>[]): number[][] {
  const costs = seeds.map(seed => {
    const cost = new Map(seed), pending = new Set(nodes)
    while (pending.size) {
      let next: Entry | undefined, best = Infinity
      for (const node of pending) if ((cost.get(node) ?? Infinity) < best) { best = cost.get(node)!; next = node }
      if (!next) break
      pending.delete(next)
      for (const neighbour of adjacency.get(next) ?? []) {
        // Centre travel stays positive even when two parser boxes touch or overlap.
        const travel = Math.hypot((next.bbox[0] + next.bbox[2] - neighbour.bbox[0] - neighbour.bbox[2]) / (2 * next.pageSize[0]),
          (next.bbox[1] + next.bbox[3] - neighbour.bbox[1] - neighbour.bbox[3]) / (2 * next.pageSize[1]))
        const candidate = best + Math.max(0.001, travel)
        if (candidate < (cost.get(neighbour) ?? Infinity)) cost.set(neighbour, candidate)
      }
    }
    return cost
  })
  return nodes.map(node => {
    const best = Math.min(...costs.map(cost => cost.get(node) ?? Infinity))
    // Close ties deliberately keep all claims, so the existing ambiguity guard preserves sources.
    return Number.isFinite(best) ? costs.flatMap((cost, index) => (cost.get(node) ?? Infinity) <= best + 0.01 ? [index] : []) : []
  })
}
function isSupporting(entry: Entry, assets: readonly Entry[]): boolean {
  if (isCaption(entry) || isAsset(entry) || HEADERS.test(type(entry))) return false
  if (CAPTIONS.has(type(entry)) || FOOTNOTES.has(type(entry)) || isFigureLabel(entry.mapping.sourceText)) return true
  // A panel caption sits right under or beside its panel, whatever type the parser gave it.
  if (PANEL_CAPTION.test(entry.mapping.sourceText) && !/\n/u.test(entry.mapping.sourceText) &&
    entry.bbox[2] - entry.bbox[0] <= entry.pageSize[0] * 0.5 &&
    assets.some(asset => { const [x, y] = gaps(entry.bbox, asset.bbox); return x <= Math.max(8, entry.pageSize[0] * 0.02) && y <= Math.max(10, entry.pageSize[1] * 0.02) })) return true
  if (type(entry) !== 'text' || !entry.mapping.sourceText.trim()) return false
  // Width alone cannot distinguish a legend from a short body paragraph.
  // Without structural ownership, require recognisable graphical notation.
  const graphical = /\b(?:solid|dashed|dotted)\s*:/iu.test(entry.mapping.sourceText) ||
    /(?:实线|實線|虚线|虛線|点线|點線)\s*[：:]/u.test(entry.mapping.sourceText) ||
    /^\s*\d+(?:\.\d+)?\s*(?:[μµu]?m|nm|mm|cm|ms|s|h|%)\s*$/u.test(entry.mapping.sourceText)
  return assets.some(asset => relatedParent(entry, asset) ||
    (graphical && entry.bbox[2] - entry.bbox[0] <= entry.pageSize[0] * 0.25 &&
      Math.min(entry.bbox[3], asset.bbox[3]) > Math.max(entry.bbox[1], asset.bbox[1]) &&
      gaps(entry.bbox, asset.bbox)[0] <= Math.max(12, entry.pageSize[0] * 0.04)))
}
function blocked(a: Entry, b: Entry, barriers: readonly Entry[]): boolean {
  const box = union([a.bbox, b.bbox])
  return barriers.some(barrier => barrier !== a && barrier !== b && overlap(box, barrier.bbox))
}
function entriesByPage(mappings: readonly BlockMapping[], hints: FigureLayoutHint[]): Map<number, Entry[]> {
  const pages = new Map<number, Entry[]>()
  for (const mapping of mappings) for (const [index, box] of mapping.boxes.entries()) {
    if (box.isDiscarded || !validBox(box.bbox, box.pageSize) || !Number.isInteger(box.pageIndex) || box.pageIndex < 0) continue
    const entries = pages.get(box.pageIndex) ?? []
    const parents = hints.filter(h => h.pageIndex === box.pageIndex &&
      (mapping.sourceAsset ? h.assets.some(a => figureAssetName(a.sourceAsset) === figureAssetName(mapping.sourceAsset!) && overlap(a.bbox, box.bbox))
        : h.captionTexts.includes(mapping.sourceText.trim()) || h.supportingTexts.includes(mapping.sourceText.trim())))
    entries.push({ key: mapping.id + ':' + index, mapping, bbox: box.bbox, pageSize: box.pageSize, parents, blockPosition: box.blockPosition })
    pages.set(box.pageIndex, entries)
  }
  // Recover panels retained by the layout without inventing persisted mapping IDs.
  for (const hint of hints) {
    const entries = pages.get(hint.pageIndex) ?? []
    for (const [index, asset] of hint.assets.entries()) if (!entries.some(e =>
      e.mapping.sourceAsset && figureAssetName(e.mapping.sourceAsset) === figureAssetName(asset.sourceAsset) && overlap(e.bbox, asset.bbox))) {
      entries.push({ key: hint.id + ':' + index, mapping: { id: '', order: 0, type: 'image', sourceText: '',
        sourceAsset: asset.sourceAsset, boxes: [] }, bbox: asset.bbox, pageSize: hint.pageSize, parents: [hint] })
    }
    for (const [index, text] of hint.texts.entries()) {
      const existing = entries.find(e => !isAsset(e) && (e.mapping.sourceText.trim() === text.sourceText && overlap(e.bbox, text.bbox) ||
        e.bbox.every((value, i) => value === text.bbox[i])))
      if (existing) {
        if (!existing.parents.includes(hint)) existing.parents.push(hint)
        continue
      }
      entries.push({ key: hint.id + ':text:' + index, mapping: { id: '', order: 0, type: text.type,
        sourceText: text.sourceText, boxes: [] }, bbox: text.bbox, pageSize: hint.pageSize, parents: [hint] })
    }
    pages.set(hint.pageIndex, entries)
  }
  return pages
}
export function validBox(box: unknown, size: unknown): box is FigureBox {
  return Array.isArray(box) && box.length === 4 && box.every(Number.isFinite) &&
    Array.isArray(size) && size.length === 2 && size.every(v => Number.isFinite(v) && v > 0) &&
    box[0] >= 0 && box[1] >= 0 && box[2] > box[0] && box[3] > box[1] && box[2] <= size[0] && box[3] <= size[1]
}

/** One caption owns a spatial component, never merely its nearest row. */
export function buildReaderFigureGeometries(mappings: readonly BlockMapping[], layoutJson?: string): ReaderFigureGeometry[] {
  const result: ReaderFigureGeometry[] = []
  const hints = readFigureLayoutHints(layoutJson)
  for (const [pageIndex, entries] of entriesByPage(mappings, hints)) {
    entries.sort((a, b) => a.mapping.order - b.mapping.order || a.key.localeCompare(b.key))
    const assets = entries.filter(isAsset)
    const captions = entries.filter(isCaption)
    const closedRows = new Map<Entry, Entry[]>()
    for (const caption of captions) {
      const row = barCaptionRow(caption, assets)
      if (!row.length) continue
      const span = union([caption.bbox, ...row.map(asset => asset.bbox)])
      const widened: FigureBox = [span[0], caption.bbox[1], span[2], caption.bbox[3]]
      // A caption set in two text columns already meets other text; leave it as it is.
      if (entries.some(entry => entry !== caption && !isAsset(entry) && !HEADERS.test(type(entry)) && overlap(widened, entry.bbox))) continue
      closedRows.set(caption, row)
      caption.bbox = widened
    }
    const captionFamilies = new Map(captions.map(anchor => [anchor, captions.filter(entry =>
      (entry.mapping.id || entry.key) === (anchor.mapping.id || anchor.key))]))
    // Two-column captions may have a Figure prefix only in their first column.
    // Join only explicitly typed caption prose at the same vertical extent;
    // panel labels and adjacent complete Figure captions remain separate.
    for (const continuation of entries.filter(e => CAPTIONS.has(type(e)) && !isCaption(e) &&
      !isFigureLabel(e.mapping.sourceText) && !/^\s*[（(][a-zA-Z][)）]/u.test(e.mapping.sourceText))) {
      const owners = captions.filter(anchor => {
        const [x, y] = gaps(anchor.bbox, continuation.bbox)
        return y === 0 && x <= Math.max(12, anchor.pageSize[0] * 0.04) &&
          Math.abs(anchor.bbox[1] - continuation.bbox[1]) <= 4 &&
          Math.abs(anchor.bbox[3] - continuation.bbox[3]) <= 12
      })
      const ids = new Set(owners.map(e => e.mapping.id || e.key))
      if (ids.size === 1) for (const owner of owners) captionFamilies.get(owner)!.push(continuation)
    }
    const captionParts = new Set([...captionFamilies.values()].flat())
    const supporting = entries.filter(e => !captionParts.has(e) && isSupporting(e, assets))
    const barriers = entries.filter(e => captionParts.has(e) || (!isAsset(e) && !supporting.includes(e) && !HEADERS.test(type(e))))
    const nodes = [...assets, ...supporting]
    const adjacency = new Map(nodes.map(e => [e, [] as Entry[]]))
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!, b = nodes[j]!
      if (adjacent(a, b) && !blocked(a, b, barriers)) {
        adjacency.get(a)!.push(b)
        adjacency.get(b)!.push(a)
      }
    }
    const grow = (seed: Entry): Entry[] => {
      const visited = new Set([seed])
      for (const node of visited) for (const neighbor of adjacency.get(node) ?? []) visited.add(neighbor)
      // Include enclosed disconnected panels before replacing any source image.
      let changed = true
      while (changed) {
        changed = false
        const box = union([...visited].map(e => e.bbox))
        for (const node of nodes) if (!visited.has(node) && overlap(box, node.bbox) &&
          ![...visited].every(v => blocked(v, node, barriers))) {
          visited.add(node)
          for (const member of visited) for (const neighbor of adjacency.get(member) ?? []) visited.add(neighbor)
          changed = true
        }
      }
      return [...visited]
    }
    const proposals: Proposal[] = []
    const seeds: Map<Entry, number>[] = []
    const linkedPanels: Entry[][] = []
    const captionIds = new Set<string>()
    for (const anchor of captions) {
      const captionId = anchor.mapping.id || anchor.key
      if (captionIds.has(captionId)) continue
      captionIds.add(captionId)
      const captionBoxes = captionFamilies.get(anchor)!
      const caption = [...captions.filter(entry => (entry.mapping.id || entry.key) === captionId)].sort((a, b) =>
        Math.min(...assets.map(asset => distance(asset, a))) - Math.min(...assets.map(asset => distance(asset, b))))[0]!
      const foreignBarriers = barriers.filter(entry => !captionBoxes.includes(entry))
      const closesRow = captionBoxes.some(part => closedRows.has(part))
      const eligible = assets.filter(asset => captionBoxes.some(part => !blocked(asset, part, foreignBarriers)) &&
        (!closesRow || captionSide(asset, anchor) === 'above'))
      // Remember every structural panel, including those behind a barrier. Losing one
      // must invalidate the whole figure rather than silently cropping its nearest row.
      // A bar caption that closes a row of panels owns the figure above it; a parser parent
      // linking it to a panel below belongs to the next figure.
      const structural = assets.filter(asset => captionBoxes.some(part => relatedParent(asset, part)) &&
        (!closesRow || captionSide(asset, anchor) === 'above'))
      const reachableLinked = structural.filter(asset => eligible.includes(asset))
      const nearest = [...(reachableLinked.length ? reachableLinked : eligible)].sort((a, b) => distance(a, caption) - distance(b, caption))[0]
      // Parser parents are noisy: a caption can be attached to the next figure.
      // A blocked parent on the opposite side cannot invalidate a clear geometric owner.
      const linked = nearest ? structural.filter(asset => captionSide(asset, caption) === captionSide(nearest, caption)) : structural
      if (!nearest || (!linked.length && distance(nearest, caption) > 0.12)) {
        proposals.push({ caption, captionBoxes, members: [], status: 'unsupported', reason: '没有可靠的图体与图说关联' })
        seeds.push(new Map())
        linkedPanels.push(linked)
        continue
      }
      // A full-width caption can directly own multiple panels even when their
      // horizontal gutter is wider than the adjacency tolerance. Each still
      // needs a clear path to the caption; competing ownership stays ambiguous.
      const captionAnchors = eligible.filter(asset => captionBoxes.some(part => {
        const [x, y] = gaps(asset.bbox, part.bbox)
        const width = Math.min(asset.bbox[2], part.bbox[2]) - Math.max(asset.bbox[0], part.bbox[0])
        const height = Math.min(asset.bbox[3], part.bbox[3]) - Math.max(asset.bbox[1], part.bbox[1])
        return !blocked(asset, part, foreignBarriers) &&
          ((y <= Math.max(12, part.pageSize[1] * 0.04) && width >= (asset.bbox[2] - asset.bbox[0]) * 0.7) ||
          (x <= Math.max(12, part.pageSize[0] * 0.04) && height >= (asset.bbox[3] - asset.bbox[1]) * 0.7))
      }))
      const candidates = [...new Set([...reachableLinked.filter(asset => linked.includes(asset)), ...captionAnchors, nearest])]
      seeds.push(new Map(candidates.map(asset => [asset, linked.includes(asset) ? 0 :
        Math.min(...captionBoxes.map(part => distance(asset, part) + 0.1 * (1 - alignment(asset, part))))])))
      linkedPanels.push(linked)
      proposals.push({ caption, captionBoxes, members: [], status: 'complete', reason: '' })
    }
    const owners = assignOwners(nodes, adjacency, seeds)
    for (const [index, proposal] of proposals.entries()) {
      if (proposal.status === 'unsupported') continue
      const members = nodes.filter((_, nodeIndex) => owners[nodeIndex]!.includes(index))
      if (!members.some(isAsset)) { proposal.status = 'unsupported'; proposal.reason = '图体优先归属于其他图说'; continue }
      const foreignBarriers = barriers.filter(entry => !proposal.captionBoxes!.includes(entry))
      const region = union(members.map(e => e.bbox))
      const hasForeign = foreignBarriers.some(b => overlap(region, b.bbox))
      const unknown = members.some(e => isAsset(e) && !e.mapping.sourceAsset)
      const captionInside = proposal.captionBoxes!.some(entry => overlap(region, entry.bbox))
      const missingLinked = linkedPanels[index]!.some(asset => !members.includes(asset))
      Object.assign(proposal, { members, status: hasForeign || unknown || captionInside || missingLinked ? 'ambiguous' : 'complete',
        reason: hasForeign ? '图区内包含其他图说、正文或表格' : unknown ? '图区内存在未知图片' : captionInside ? '无法将图说与图体分离' : missingLinked ? '结构化图体被正文或表格分隔' : '图说与完整空间图区唯一对应' })
    }
    const used = new Set(proposals.flatMap(p => p.members))
    for (const asset of assets) if (!used.has(asset)) {
      const members = grow(asset)
      members.forEach(m => used.add(m))
      const parent = asset.parents.find(p => p.assets.length > 1 && p.captionTexts.length === 0 &&
        p.assets.every(a => members.some(m => m.mapping.sourceAsset && figureAssetName(m.mapping.sourceAsset) === figureAssetName(a.sourceAsset))))
      const complete = Boolean(parent) && members.every(m => !isAsset(m) || Boolean(m.mapping.sourceAsset)) &&
        !barriers.some(b => overlap(union(members.map(m => m.bbox)), b.bbox))
      proposals.push({ members, status: complete ? 'complete' : 'unsupported',
        reason: complete ? '解析器明确保留了完整复合图体' : '缺少完整图说或明确整图边界' })
    }
    for (const proposal of proposals) {
      if (proposals.some(other => other !== proposal && proposal.members.some(m => other.members.includes(m)))) {
        proposal.status = 'ambiguous'
        proposal.reason = '子图存在多个图说归属'
      }
      const visual = proposal.members.filter(isAsset).sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0] || a.key.localeCompare(b.key))
      const sorted = [...proposal.members].sort((a, b) => a.mapping.order - b.mapping.order)
      const size = proposal.caption?.pageSize ?? sorted[0]!.pageSize
      const bodyBox = union((sorted.length ? sorted : [proposal.caption!]).map(e => e.bbox))
      // A single resource's parser box can omit PDF text extending past its
      // sides (for example an attention diagram's title). A wider caption
      // supplies a horizontal figure corridor, without including its prose.
      // All foreign text and images in the resulting corridor are checked below.
      if (proposal.status === 'complete' && visual.length === 1 && proposal.captionBoxes?.length) {
        const captionBox = union(proposal.captionBoxes.map(e => e.bbox))
        if ((captionBox[1] >= bodyBox[3] || captionBox[3] <= bodyBox[1]) &&
          captionBox[0] <= bodyBox[0] && captionBox[2] >= bodyBox[2] &&
          captionBox[2] - captionBox[0] >= (bodyBox[2] - bodyBox[0]) * 1.25) {
          bodyBox[0] = captionBox[0]
          bodyBox[2] = captionBox[2]
        }
      }
      const cropBox = paddedWithinWhitespace(bodyBox, size, entries.filter(entry =>
        barriers.includes(entry) || HEADERS.test(type(entry)) || (isAsset(entry) && !proposal.members.includes(entry))))
      if (proposal.status === 'complete' && barriers.some(b => overlap(cropBox, b.bbox))) {
        proposal.status = 'ambiguous'
        proposal.reason = '裁图边缘与图说、正文或表格重叠'
      }
      if (proposal.status === 'complete' && entries.some(e => HEADERS.test(type(e)) && overlap(cropBox, e.bbox))) {
        proposal.status = 'ambiguous'
        proposal.reason = '裁图包含页眉或页脚'
      }
      if (proposal.status === 'complete' && assets.some(asset => !proposal.members.includes(asset) && overlap(cropBox, asset.bbox))) {
        proposal.status = 'ambiguous'
        proposal.reason = '裁图边缘包含归属未确认的图片'
      }
      // A lost coordinate must not turn a known compound figure into a partial
      // success. A valid alternative box or layout recovery can resolve it.
      const unresolved = hints.some(hint => hint.pageIndex === pageIndex && hint.unresolvedAssets.some(name =>
        !assets.some(asset => asset.mapping.sourceAsset && figureAssetName(asset.mapping.sourceAsset) === figureAssetName(name)))) ||
        mappings.some(mapping => ASSETS.has(mapping.type.trim().toLowerCase().replace(/[\s-]+/gu, '_')) &&
        mapping.boxes.some(box => !box.isDiscarded && box.pageIndex === pageIndex && !validBox(box.bbox, box.pageSize)) &&
        !assets.some(asset => asset.mapping.id === mapping.id || (mapping.sourceAsset && asset.mapping.sourceAsset &&
          figureAssetName(mapping.sourceAsset) === figureAssetName(asset.mapping.sourceAsset))))
      if (proposal.status === 'complete' && (unresolved || sorted.some(e => e.pageSize[0] !== size[0] || e.pageSize[1] !== size[1]))) {
        proposal.status = 'ambiguous'
        proposal.reason = unresolved ? '同页图片坐标损坏，无法确认整图完整性' : '成员页面尺寸不一致'
      }
      result.push({
        id: 'reader-figure-' + pageIndex + '-' + (proposal.caption?.key ?? visual[0]!.key),
        pageIndex, cropBox, pageSize: size, status: proposal.status, reason: proposal.reason,
        mappingIds: [...new Set([...sorted.map(e => e.mapping.id), ...(proposal.captionBoxes ?? []).map(e => e.mapping.id)].filter(Boolean))],
        assetSources: [...new Set(visual.map(e => e.mapping.sourceAsset).filter((a): a is string => Boolean(a)))],
        captionMappingId: proposal.caption?.mapping.id ?? '',
        captionLabel: proposal.caption ? captionLabel(proposal.caption.mapping.sourceText) : undefined,
        captionBlockPosition: proposal.caption?.blockPosition,
        fallbackLegendText: sorted.filter(e => !isAsset(e) && !isFigureLabel(e.mapping.sourceText)).map(e => e.mapping.sourceText.trim()).filter(Boolean).join(' '),
        members: sorted.map(e => ({ mappingId: e.mapping.id || undefined, blockPosition: e.blockPosition, bbox: e.bbox, sourceAsset: e.mapping.sourceAsset,
          sourceText: e.mapping.sourceText, kind: isAsset(e) ? 'asset' : 'supporting' }))
      })
    }
  }
  for (const geometry of result) if (geometry.status === 'complete' && result.some(other => other !== geometry &&
    other.pageIndex !== geometry.pageIndex && geometry.mappingIds.some(id => other.mappingIds.includes(id)))) {
    geometry.status = 'ambiguous'
    geometry.reason = '图体映射跨页，保留逐页来源'
  }
  return result.sort((a, b) => a.pageIndex - b.pageIndex || a.cropBox[1] - b.cropBox[1])
}

export function projectReaderFigureGroups(geometries: readonly ReaderFigureGeometry[], blocks: readonly ReaderBlock[], referenceBlocks?: readonly ReaderBlock[]): ReaderFigureGroup[] {
  const blockAssets = blocks.map(block => markdownAssetSources(block.markdown).map(figureAssetName))
  const labels = blocks.map(block => captionLabel(block.markdown))
  const groups = geometries.flatMap(geometry => {
    const names = new Set(geometry.assetSources.map(figureAssetName))
    const indexes = blocks.flatMap((block, index) => block.role === 'content' &&
      (blockAssets[index]!.some(asset => names.has(asset)) ||
        (geometry.captionLabel && labels[index] === geometry.captionLabel && block.mappingIds.includes(geometry.captionMappingId)) ||
        (!blockAssets[index]!.length && !labels[index] && block.mappingIds.some(id => geometry.mappingIds.includes(id)))) ? [index] : [])
    if (!indexes.length) return []
    const captionIndex = indexes.find(index => geometry.captionLabel && labels[index] === geometry.captionLabel &&
      blocks[index]!.mappingIds.includes(geometry.captionMappingId)) ??
      indexes.find(index => blocks[index]!.mappingIds.includes(geometry.captionMappingId)) ?? -1
    const caption = captionIndex < 0 ? '' : captionFromMarkdown(blocks[captionIndex]!.markdown)
    // A parser can join Figure N's caption and Figure N+1's first image into one
    // Markdown paragraph. Put N+1's snapshot after that foreign caption, while
    // keeping the original paragraph, mapping IDs and annotation offsets intact.
    const owner = indexes.find(index => blockAssets[index]!.some(asset => names.has(asset)) &&
      (!labels[index] || labels[index] === geometry.captionLabel)) ?? (captionIndex >= 0 ? captionIndex : indexes[0]!)
    const group: ReaderFigureGroup = { ...geometry, ownerBlockIndex: owner, captionBlockIndex: captionIndex,
      memberBlockIndexes: indexes, captionMarkdown: caption, supportingTextsByBlock: {} }
    const resolvedTexts = new Set<string>()
    for (const index of indexes) {
      const block = blocks[index]!
      const assets = markdownAssetSources(block.markdown).map(figureAssetName)
      const matchingAssets = assets.length ? referenceBlocks?.filter(source => {
        const names = markdownAssetSources(source.markdown).map(figureAssetName)
        return names.length === assets.length && assets.every(name => names.includes(name))
      }) : []
      const reference = matchingAssets?.length === 1 ? matchingAssets[0] : referenceBlocks?.find(source =>
        source.annotationKey && source.annotationKey === block.annotationKey && block.mappingIds.length &&
        block.mappingIds.every(id => source.mappingIds.includes(id)))
      const texts = geometry.members.filter(member => member.kind === 'supporting').map(member => member.sourceText)
      const projected = projectSupportingTexts(reference?.markdown ?? block.markdown, block.markdown, texts)
      projected.resolved.forEach(text => resolvedTexts.add(text))
      group.supportingTextsByBlock![index] = projected.texts
      if (!projected.complete && group.status === 'complete') {
        group.status = 'ambiguous'
        group.reason = '译文图内文字与来源结构不一致，保留全部来源'
      }
    }
    if (referenceBlocks && group.status === 'complete' && geometry.members.some(member => member.kind === 'supporting' &&
      member.sourceText.trim() && !isFigureLabel(member.sourceText) && !resolvedTexts.has(member.sourceText) &&
      referenceBlocks.some(block => block.markdown.replace(/\s+/gu, '').includes(member.sourceText.replace(/\s+/gu, ''))))) {
      group.status = 'ambiguous'
      group.reason = '无法确认译文图内文字归属，保留全部来源'
    }
    return [group]
  })
  for (const group of groups) if (groups.some(other => other !== group && group.memberBlockIndexes.some(i =>
    other.memberBlockIndexes.includes(i) && !(blockAssets[i]!.length && labels[i] &&
      (labels[i] === group.captionLabel || labels[i] === other.captionLabel) &&
      [group, other].some(owner => blockAssets[i]!.every(asset => owner.assetSources.some(source => figureAssetName(source) === asset))))))) {
    group.status = 'ambiguous'
    group.reason = '同一阅读区块包含多个图区，保留完整来源'
  }
  return groups
}

type TextNode = { type: string; value?: string; url?: string; children?: TextNode[] }
const figureTextParser = unified().use(remarkParse)
const supportingCache = new Map<string, { texts: string[]; complete: boolean; resolved: string[] }>()
/** Cached: projecting figure groups again after an edit must not re-parse every figure paragraph. */
function projectSupportingTexts(source: string, target: string, knownTexts: string[]): { texts: string[]; complete: boolean; resolved: string[] } {
  const key = [source, target, ...knownTexts].join('\u0000')
  let result = supportingCache.get(key)
  if (!result) {
    result = computeSupportingTexts(source, target, knownTexts)
    if (supportingCache.size >= 2_000) supportingCache.delete(supportingCache.keys().next().value!)
    supportingCache.set(key, result)
  }
  return result
}
function computeSupportingTexts(source: string, target: string, knownTexts: string[]): { texts: string[]; complete: boolean; resolved: string[] } {
  const normalize = (text: string): string => text.replace(/\s+/gu, '')
  const known = new Set(knownTexts.map(normalize).filter(Boolean))
  const original = figureTextParser.parse(source) as TextNode
  const translated = source === target ? original : figureTextParser.parse(target) as TextNode
  const textOf = (node: TextNode): string => node.type === 'text' ? node.value ?? '' : (node.children ?? []).map(textOf).join('')
  const shape = (node: TextNode): string => node.type + (node.type === 'image' ? ':' + figureAssetName(node.url ?? '') : '') +
    '(' + (node.children ?? []).map(shape).join(',') + ')'
  const structureMatches = shape(original) === shape(translated)
  const texts = [...knownTexts]
  const resolved: string[] = []
  let complete = true
  const visit = (a: TextNode, b?: TextNode): void => {
    const text = textOf(a)
    if ((a.type === 'text' || a.type === 'paragraph') && known.has(normalize(text))) {
      if (!structureMatches || !b || shape(a) !== shape(b)) complete = false
      else {
        texts.push(textOf(b))
        resolved.push(...knownTexts.filter(knownText => normalize(knownText) === normalize(text)))
        // Preserve text nodes and their offsets; only known graphical text is hidden.
        const collect = (node: TextNode): void => {
          if (node.type === 'text' && node.value?.trim()) texts.push(node.value)
          for (const child of node.children ?? []) collect(child)
        }
        collect(b)
      }
      return
    }
    for (const [index, child] of (a.children ?? []).entries()) visit(child, b?.children?.[index])
  }
  visit(original, translated)
  return { texts: [...new Set(texts.filter(text => text.trim()))], complete, resolved }
}
export function buildReaderFigureGroups(blocks: readonly ReaderBlock[], mappings: readonly BlockMapping[], layoutJson?: string): ReaderFigureGroup[] {
  return projectReaderFigureGroups(buildReaderFigureGeometries(mappings, layoutJson), blocks)
}
const assetSourceCache = new Map<string, string[]>()
export function markdownAssetSources(markdown: string): string[] {
  let sources = assetSourceCache.get(markdown)
  if (!sources) {
    sources = scanAssetSources(markdown)
    if (assetSourceCache.size >= 8_000) assetSourceCache.delete(assetSourceCache.keys().next().value!)
    assetSourceCache.set(markdown, sources)
  }
  return sources
}
function scanAssetSources(markdown: string): string[] {
  return [...markdown.matchAll(/!\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+["'][^"']*["'])?\s*\)|<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/giu)]
    .map(match => match[1] ?? match[2]!)
}
function captionFromMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n?/gu, '\n').split('\n')
  const start = lines.findIndex(line => FIGURE_PREFIX.test(line.replace(/^[*_]+/u, '')))
  return start < 0 ? '' : lines.slice(start).join('\n').trim()
}
