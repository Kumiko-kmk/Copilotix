import type { ReaderBlock } from '@shared/readerDocument'
import type { BlockMapping } from '@shared/types'
import { readFigureLayoutHints, type FigureLayoutHint } from './readerFigureLayout'
import { unified } from 'unified'
import remarkParse from 'remark-parse'

export type FigureBox = [number, number, number, number]
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
const FIGURE_PREFIX = /^\s*(?:(?:supplementary|extended\s+data)\s+)?(?:fig(?:ure)?\.?|[附補补]?圖|[附补]?图)\s*(?:[A-Z]\.?\s*)?\d+[A-Z]?(?:\b|(?=[：:．.、\s]))/iu
const LABEL = /^\s*(?:[（(]\s*[a-zA-Z一二三四五六七八九十]+\s*[)）]|[A-Z])\s*[.。]?\s*$/u

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
    /^[^:：]*\d+[A-Z]?\s*[.:：．、]/iu.test(entry.mapping.sourceText))
}
function isAsset(entry: Entry): boolean { return ASSETS.has(type(entry)) }
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
function isSupporting(entry: Entry, assets: readonly Entry[]): boolean {
  if (isCaption(entry) || isAsset(entry) || HEADERS.test(type(entry))) return false
  if (CAPTIONS.has(type(entry)) || FOOTNOTES.has(type(entry)) || isFigureLabel(entry.mapping.sourceText)) return true
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
    for (const [index, text] of hint.texts.entries()) if (!entries.some(e =>
      e.mapping.sourceText.trim() === text.sourceText && overlap(e.bbox, text.bbox))) {
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
    const supporting = entries.filter(e => isSupporting(e, assets))
    const barriers = entries.filter(e => isCaption(e) || (!isAsset(e) && !supporting.includes(e) && !HEADERS.test(type(e))))
    const nodes = [...assets, ...supporting]
    const adjacency = new Map(nodes.map(e => [e, [] as Entry[]]))
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!, b = nodes[j]!
      const [x, y] = gaps(a.bbox, b.bbox)
      if ((relatedParent(a, b) || (x <= Math.max(12, a.pageSize[0] * 0.04) && y <= Math.max(12, a.pageSize[1] * 0.04))) &&
        !blocked(a, b, barriers)) {
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
    const proposals: Array<{ caption?: Entry; members: Entry[]; status: FigureStatus; reason: string }> = []
    const captionIds = new Set<string>()
    for (const anchor of captions) {
      const captionId = anchor.mapping.id || anchor.key
      if (captionIds.has(captionId)) continue
      captionIds.add(captionId)
      const captionBoxes = captions.filter(entry => (entry.mapping.id || entry.key) === captionId)
      const caption = [...captionBoxes].sort((a, b) =>
        Math.min(...assets.map(asset => distance(asset, a))) - Math.min(...assets.map(asset => distance(asset, b))))[0]!
      const foreignBarriers = barriers.filter(entry => !captionBoxes.includes(entry))
      const eligible = assets.filter(asset => !blocked(asset, caption, foreignBarriers))
      const linked = eligible.filter(asset => relatedParent(asset, caption))
      const nearest = [...(linked.length ? linked : eligible)].sort((a, b) => distance(a, caption) - distance(b, caption))[0]
      if (!nearest || (!linked.length && distance(nearest, caption) > 0.12)) {
        proposals.push({ caption, members: [], status: 'unsupported', reason: '没有可靠的图体与图说关联' })
        continue
      }
      const members = grow(nearest)
      const region = union(members.map(e => e.bbox))
      const hasForeign = foreignBarriers.some(b => overlap(region, b.bbox))
      const unknown = members.some(e => isAsset(e) && !e.mapping.sourceAsset)
      const captionInside = captionBoxes.some(entry => overlap(region, entry.bbox))
      const missingLinked = linked.some(asset => !members.includes(asset))
      proposals.push({ caption, members, status: hasForeign || unknown || captionInside || missingLinked ? 'ambiguous' : 'complete',
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
      const cropBox = padded(union((sorted.length ? sorted : [proposal.caption!]).map(e => e.bbox)), size)
      if (proposal.status === 'complete' && barriers.some(b => overlap(cropBox, b.bbox))) {
        proposal.status = 'ambiguous'
        proposal.reason = '裁图边缘与图说、正文或表格重叠'
      }
      if (proposal.status === 'complete' && entries.some(e => HEADERS.test(type(e)) && overlap(cropBox, e.bbox))) {
        proposal.status = 'ambiguous'
        proposal.reason = '裁图包含页眉或页脚'
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
        mappingIds: [...new Set([...sorted.map(e => e.mapping.id), proposal.caption?.mapping.id ?? ''].filter(Boolean))],
        assetSources: [...new Set(visual.map(e => e.mapping.sourceAsset).filter((a): a is string => Boolean(a)))],
        captionMappingId: proposal.caption?.mapping.id ?? '',
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
  const groups = geometries.flatMap(geometry => {
    const names = new Set(geometry.assetSources.map(figureAssetName))
    const indexes = blocks.flatMap((block, index) => block.role === 'content' &&
      (block.mappingIds.some(id => geometry.mappingIds.includes(id)) ||
        markdownAssetSources(block.markdown).some(asset => names.has(figureAssetName(asset)))) ? [index] : [])
    if (!indexes.length) return []
    const captionIndex = indexes.find(index => blocks[index]!.mappingIds.includes(geometry.captionMappingId)) ?? -1
    const caption = captionIndex < 0 ? '' : captionFromMarkdown(blocks[captionIndex]!.markdown)
    const group: ReaderFigureGroup = { ...geometry, ownerBlockIndex: Math.min(...indexes), captionBlockIndex: captionIndex,
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
  for (const group of groups) if (groups.some(other => other !== group && group.memberBlockIndexes.some(i => other.memberBlockIndexes.includes(i)))) {
    group.status = 'ambiguous'
    group.reason = '同一阅读区块包含多个图区，保留完整来源'
  }
  return groups
}

type TextNode = { type: string; value?: string; url?: string; children?: TextNode[] }
const figureTextParser = unified().use(remarkParse)
function projectSupportingTexts(source: string, target: string, knownTexts: string[]): { texts: string[]; complete: boolean; resolved: string[] } {
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
export function markdownAssetSources(markdown: string): string[] {
  return [...markdown.matchAll(/!\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+["'][^"']*["'])?\s*\)|<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/giu)]
    .map(match => match[1] ?? match[2]!)
}
function captionFromMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n?/gu, '\n').split('\n')
  const start = lines.findIndex(line => FIGURE_PREFIX.test(line.replace(/^[*_]+/u, '')))
  return start < 0 ? '' : lines.slice(start).join('\n').trim()
}
