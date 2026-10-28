import React from 'react'
import { archiveTitle } from '../../core/paperProfile'
import type { ArchivePaper, ArchiveShelf } from './archiveShelves'
import './ArchiveOverview.css'

/**
 * Whole-library overview drawn as a layered network: 文库 → categories → papers. Real
 * membership is the accent; the faint all-to-all mesh between adjacent layers is decoration.
 */

interface Props {
  shelves: readonly ArchiveShelf[]
  /** Translated titles from the archive catalog, when known. */
  translatedTitle(paperId: string): string | undefined
  onPick(paperId: string): void
  onClose(): void
}

interface Layer<T> { x: number; nodes: Array<T & { y: number }> }
type CategoryNode = { key: string; name: string; papers: ArchivePaper[] }
type PaperNode = { paper: ArchivePaper; category: string }

const NODE_GAP = 26
/** Above this many decorative lines the mesh is skipped; it would only add noise and cost. */
const MESH_LIMIT = 900

function uniqueCategories(shelves: readonly ArchiveShelf[]): CategoryNode[] {
  const byName = new Map<string, CategoryNode>()
  for (const shelf of shelves) {
    const node = byName.get(shelf.category) ?? { key: shelf.key, name: shelf.category, papers: [] }
    for (const paper of shelf.papers) if (!node.papers.some((known) => known.id === paper.id)) node.papers.push(paper)
    byName.set(shelf.category, node)
  }
  return [...byName.values()]
}

function statusTone(paper: ArchivePaper): string {
  switch (paper.workflow.status) {
    case 'completed': return 'done'
    case 'partial': return 'partial'
    case 'failed': return 'failed'
    default: return 'active'
  }
}

const curve = (x1: number, y1: number, x2: number, y2: number): string => {
  const mid = (x1 + x2) / 2
  return `M${x1.toFixed(1)} ${y1.toFixed(1)}C${mid.toFixed(1)} ${y1.toFixed(1)} ${mid.toFixed(1)} ${y2.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`
}

export default function ArchiveOverview(props: Props): React.JSX.Element {
  const hostRef = React.useRef<HTMLDivElement>(null)
  const [size, setSize] = React.useState({ width: 0, height: 0 })
  const [focusCategory, setFocusCategory] = React.useState<string | null>(null)

  React.useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    const measure = (): void => setSize({ width: host.clientWidth, height: host.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  const categories = React.useMemo(() => uniqueCategories(props.shelves), [props.shelves])
  const paperCount = categories.reduce((sum, category) => sum + category.papers.length, 0)

  const layout = React.useMemo(() => {
    const { width, height } = size
    if (!width || !height) return null
    const top = 24
    // Papers set the height; the stage scrolls when the library is taller than the window.
    const available = height - top * 2
    const gap = Math.max(NODE_GAP, available / Math.max(1, paperCount))
    const contentHeight = Math.max(available, gap * paperCount)
    const papers: Layer<PaperNode> = { x: width * 0.58, nodes: [] }
    const cats: Layer<CategoryNode> = { x: width * 0.34, nodes: [] }
    let index = 0
    for (const category of categories) {
      const first = index
      for (const paper of category.papers) {
        papers.nodes.push({ paper, category: category.name, y: top + gap * (index + 0.5) })
        index++
      }
      const ys = papers.nodes.slice(first, index).map((node) => node.y)
      cats.nodes.push({ ...category, y: ys.length ? (ys[0]! + ys[ys.length - 1]!) / 2 : top })
    }
    const root = { x: width * 0.12, y: top + contentHeight / 2 }
    return { papers, cats, root, contentHeight: contentHeight + top * 2, width }
  }, [size, categories, paperCount])

  const mesh = layout && layout.cats.nodes.length * layout.papers.nodes.length <= MESH_LIMIT
    ? layout.cats.nodes.flatMap((cat) => layout.papers.nodes.map((node) => curve(layout.cats.x, cat.y, layout.papers.x, node.y)))
    : []

  return (
    <div ref={hostRef} className="archive-overview" role="dialog" aria-label="全部论文"
      onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); props.onClose() } }}>
      <div className="archive-overview-head">
        <span className="paper-archive-eyebrow">LIBRARY NETWORK</span>
        <strong>全部论文</strong>
        <span>{paperCount} 篇 · {categories.length} 个分类</span>
      </div>
      {layout ? (
        <div className="archive-overview-scroll">
          <div className="archive-overview-canvas" style={{ height: layout.contentHeight }}>
            <svg className="archive-overview-links" width={layout.width} height={layout.contentHeight} aria-hidden="true">
              <g className="archive-overview-mesh">
                {mesh.map((d, i) => <path key={i} d={d} />)}
              </g>
              <g className="archive-overview-edges layer-1">
                {layout.cats.nodes.map((cat) => (
                  <path key={cat.key} d={curve(layout.root.x, layout.root.y, layout.cats.x, cat.y)}
                    className={focusCategory && focusCategory !== cat.name ? 'dim' : undefined} />
                ))}
              </g>
              <g className="archive-overview-edges layer-2">
                {layout.papers.nodes.map((node) => {
                  const cat = layout.cats.nodes.find((item) => item.name === node.category)!
                  return <path key={node.paper.id} d={curve(layout.cats.x, cat.y, layout.papers.x, node.y)}
                    className={focusCategory && focusCategory !== node.category ? 'dim' : undefined} />
                })}
              </g>
              <circle className="archive-overview-node root" cx={layout.root.x} cy={layout.root.y} r={9} />
              {layout.cats.nodes.map((cat) => (
                <circle key={cat.key} className={`archive-overview-node category${focusCategory === cat.name ? ' focused' : ''}`} cx={layout.cats.x} cy={cat.y} r={6} />
              ))}
              {layout.papers.nodes.map((node) => (
                <circle key={node.paper.id} className={`archive-overview-node paper tone-${statusTone(node.paper)}${focusCategory && focusCategory !== node.category ? ' dim' : ''}`}
                  cx={layout.papers.x} cy={node.y} r={5} />
              ))}
            </svg>

            <div className="archive-overview-label root" style={{ left: layout.root.x, top: layout.root.y }}>
              <strong>文库</strong><small>{paperCount} 篇</small>
            </div>
            {layout.cats.nodes.map((cat) => (
              <button key={cat.key} type="button" style={{ left: layout.cats.x, top: cat.y }}
                className={`archive-overview-label category${focusCategory === cat.name ? ' focused' : ''}${focusCategory && focusCategory !== cat.name ? ' dim' : ''}`}
                aria-pressed={focusCategory === cat.name}
                onClick={() => setFocusCategory((current) => current === cat.name ? null : cat.name)}>
                <strong>{cat.name}</strong><small>{cat.papers.length} 篇</small>
              </button>
            ))}
            {layout.papers.nodes.map((node) => {
              const translated = props.translatedTitle(node.paper.id)
              return (
                <button key={node.paper.id} type="button" style={{ left: layout.papers.x, top: node.y, width: layout.width * 0.95 - layout.papers.x }}
                  className={`archive-overview-label paper${focusCategory && focusCategory !== node.category ? ' dim' : ''}`}
                  onClick={() => props.onPick(node.paper.id)}>
                  <span>{translated || archiveTitle(node.paper.displayName)}</span>
                  {translated ? <small>{archiveTitle(node.paper.displayName)}</small> : null}
                </button>
              )
            })}
          </div>
        </div>
      ) : null}
    </div>
  )
}
