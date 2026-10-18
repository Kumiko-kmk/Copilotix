import type { FigureBox } from './readerFigureGroups'

export interface FigureLayoutHint {
  id: string
  pageIndex: number
  pageSize: [number, number]
  assets: Array<{ sourceAsset: string; bbox: FigureBox }>
  captionTexts: string[]
  supportingTexts: string[]
  texts: Array<{ sourceText: string; bbox: FigureBox; type: string }>
  unresolvedAssets: string[]
}
type LayoutNode = { type?: string; bbox?: unknown; text?: string; blocks?: LayoutNode[];
  lines?: Array<{ spans?: Array<{ image_path?: string; content?: string }> }> }

/** Read existing layout metadata without rebuilding mappings or their IDs. */
export function readFigureLayoutHints(json?: string): FigureLayoutHint[] {
  if (!json) return []
  try {
    const layout = JSON.parse(json) as { pdf_info?: Array<{ page_idx?: number; page_size?: [number, number]; para_blocks?: LayoutNode[] }> }
    if (!Array.isArray(layout.pdf_info)) return []
    return layout.pdf_info.flatMap((page, pageOrder) => {
      const size = page.page_size
      const pageIndex = page.page_idx ?? pageOrder
      if (!size || size.length !== 2 || !size.every(v => Number.isFinite(v) && v > 0) || !Number.isInteger(pageIndex) || pageIndex < 0) return []
      return (page.para_blocks ?? []).flatMap((parent, parentIndex) => {
        if (!['image', 'chart'].includes(parent.type ?? '')) return []
        const assets: FigureLayoutHint['assets'] = []
        const captionTexts: string[] = []
        const supportingTexts: string[] = []
        const texts: FigureLayoutHint['texts'] = []
        const unresolvedAssets: string[] = []
        const walk = (node: LayoutNode): void => {
          const text = node.text?.trim() || (node.lines ?? []).flatMap(l => (l.spans ?? []).map(s => s.content ?? '')).join(' ').trim()
          if (text) {
            if (/^(?:image|chart)_caption$/u.test(node.type ?? '')) captionTexts.push(text)
            else supportingTexts.push(text)
          }
          const box = node.bbox
          if (Array.isArray(box) && box.length === 4 && box.every(Number.isFinite) &&
            box[0] >= 0 && box[1] >= 0 && box[2] > box[0] && box[3] > box[1] && box[2] <= size[0] && box[3] <= size[1]) {
            for (const line of node.lines ?? []) for (const span of line.spans ?? []) if (span.image_path) {
              assets.push({ sourceAsset: span.image_path, bbox: box as FigureBox })
            }
            if (text && !['image', 'chart', 'image_body', 'chart_body'].includes(node.type ?? '')) {
              texts.push({ sourceText: text, bbox: box as FigureBox, type: node.type ?? 'text' })
            }
          } else {
            for (const line of node.lines ?? []) for (const span of line.spans ?? []) if (span.image_path) unresolvedAssets.push(span.image_path)
          }
          for (const child of node.blocks ?? []) walk(child)
        }
        walk(parent)
        return assets.length || unresolvedAssets.length ? [{ id: 'layout-figure-' + pageIndex + '-' + parentIndex, pageIndex, pageSize: size, assets, captionTexts, supportingTexts, texts, unresolvedAssets }] : []
      })
    })
  } catch { return [] }
}
