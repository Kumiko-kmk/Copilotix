import { findGroup, groupOfView, type LayoutNode, type ReaderLayout, type ReaderViewId, type SplitSide } from '../readerLayout'

/** Drag-and-drop geometry of the reader workbench: drop zones and whether a drop keeps the layout valid. */

/** Smallest group size a split may produce; below this a reader stops being usable. */
export const MIN_GROUP_WIDTH = 240

export const MIN_GROUP_HEIGHT = 140
export type DropZone = 'center' | SplitSide

/**
 * Smallest width (row) or height (column) a node needs so none of its groups
 * goes below the minimum. With at most four views this always fits the
 * minimum window, so narrowing the window shrinks groups but never hides one.
 */
export function minNodeExtent(node: LayoutNode, direction: 'row' | 'column'): number {
  if (node.kind === 'group') return direction === 'row' ? MIN_GROUP_WIDTH : MIN_GROUP_HEIGHT
  const extents = node.children.map((child) => minNodeExtent(child, direction))
  return node.direction === direction ? extents.reduce((sum, extent) => sum + extent, 0) : Math.max(...extents)
}

export interface Bounds { left: number; top: number; width: number; height: number }

/** Edge quarters split the group on that side; the middle merges the tab into it. */
export function dropZoneAt(bounds: Bounds, x: number, y: number): DropZone {
  if (bounds.width <= 0 || bounds.height <= 0) return 'center'
  const rx = (x - bounds.left) / bounds.width
  const ry = (y - bounds.top) / bounds.height
  const edges: Array<[SplitSide, number]> = [['left', rx], ['right', 1 - rx], ['top', ry], ['bottom', 1 - ry]]
  const [side, distance] = edges.reduce((best, edge) => edge[1] < best[1] ? edge : best)
  return distance < 0.25 ? side : 'center'
}

/** Whether dropping `view` on a zone of `groupId` changes anything, and why not. */
export function dropVerdict(layout: ReaderLayout, view: ReaderViewId, groupId: string, zone: DropZone, bounds?: Bounds): { allowed: boolean; reason?: string } {
  const source = groupOfView(layout, view)
  if (!source || !findGroup(layout, groupId)) return { allowed: false }
  if (zone === 'center') return source.id === groupId ? { allowed: false, reason: '已在此分组' } : { allowed: true }
  if (source.id === groupId && source.views.length === 1) return { allowed: false, reason: '已在此分组' }
  const horizontal = zone === 'left' || zone === 'right'
  const extent = horizontal ? bounds?.width : bounds?.height
  const minimum = horizontal ? MIN_GROUP_WIDTH : MIN_GROUP_HEIGHT
  if (extent && extent < minimum * 2) return { allowed: false, reason: '空间不足' }
  return { allowed: true }
}
