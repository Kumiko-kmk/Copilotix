/**
 * Reader workbench layout: an editor-style tree of splits and tab groups.
 *
 * Every view appears exactly once, either in one group or in `hidden`, so a
 * heavy reader is never mounted twice and paragraph linking stays unambiguous.
 * All operations are pure and return a normalized layout; invalid requests
 * return the input unchanged.
 */

export type ReaderViewId = 'pdf' | 'original' | 'translated' | 'chat'
export const READER_VIEW_IDS: readonly ReaderViewId[] = ['pdf', 'original', 'translated', 'chat']

export type SplitDirection = 'row' | 'column'
export type SplitSide = 'left' | 'right' | 'top' | 'bottom'

export interface LayoutGroup {
  kind: 'group'
  id: string
  views: ReaderViewId[]
  active: ReaderViewId
}

export interface LayoutSplit {
  kind: 'split'
  id: string
  direction: SplitDirection
  children: LayoutNode[]
  /** Percentages of the parent, one per child, summing to 100. */
  sizes: number[]
}

export type LayoutNode = LayoutGroup | LayoutSplit

export interface ReaderLayout {
  version: 1
  root: LayoutNode
  /** Views closed by the user, most recently hidden last. */
  hidden: ReaderViewId[]
}

export const LAYOUT_STORAGE_KEY = 'copilotix.reader.layout.v1'
const LEGACY_SPLIT_KEY = 'copilotix.reader.split-percent'
export const DEFAULT_PDF_PERCENT = 100 / 2.05

export function defaultReaderLayout(pdfPercent = DEFAULT_PDF_PERCENT): ReaderLayout {
  const left = Number.isFinite(pdfPercent) && pdfPercent >= 20 && pdfPercent <= 80 ? pdfPercent : DEFAULT_PDF_PERCENT
  return {
    version: 1,
    hidden: [],
    root: {
      kind: 'split',
      id: 's1',
      direction: 'row',
      sizes: [left, 100 - left],
      children: [
        { kind: 'group', id: 'g1', views: ['pdf'], active: 'pdf' },
        { kind: 'group', id: 'g2', views: ['original', 'translated', 'chat'], active: 'original' }
      ]
    }
  }
}

// ── Queries ──────────────────────────────────────────────────────────────

export function listGroups(node: LayoutNode): LayoutGroup[] {
  return node.kind === 'group' ? [node] : node.children.flatMap(listGroups)
}

export function findGroup(layout: ReaderLayout, groupId: string): LayoutGroup | undefined {
  return listGroups(layout.root).find((group) => group.id === groupId)
}

export function groupOfView(layout: ReaderLayout, view: ReaderViewId): LayoutGroup | undefined {
  return listGroups(layout.root).find((group) => group.views.includes(view))
}

export function visibleViews(layout: ReaderLayout): ReaderViewId[] {
  return listGroups(layout.root).flatMap((group) => group.views)
}

function findParent(node: LayoutNode, id: string): LayoutSplit | undefined {
  if (node.kind === 'group') return undefined
  if (node.children.some((child) => child.id === id)) return node
  for (const child of node.children) {
    const parent = findParent(child, id)
    if (parent) return parent
  }
  return undefined
}

// ── Operations ───────────────────────────────────────────────────────────

/** Make a visible view the active tab of its group. */
export function activateView(layout: ReaderLayout, view: ReaderViewId): ReaderLayout {
  const group = groupOfView(layout, view)
  if (!group || group.active === view) return layout
  return withRoot(layout, mapGroups(layout.root, (item) => item.id === group.id ? { ...item, active: view } : item))
}

/** Close a view; the last visible view cannot be hidden. */
export function hideView(layout: ReaderLayout, view: ReaderViewId): ReaderLayout {
  if (!groupOfView(layout, view) || visibleViews(layout).length <= 1) return layout
  const root = removeView(layout.root, view)
  if (!root) return layout
  return normalizeLayout({ ...layout, root, hidden: [...layout.hidden.filter((item) => item !== view), view] })
}

/** Reopen a hidden view as the active tab of `targetGroupId` (or the first group). */
export function revealView(layout: ReaderLayout, view: ReaderViewId, targetGroupId?: string): ReaderLayout {
  if (groupOfView(layout, view)) return activateView(layout, view)
  if (!layout.hidden.includes(view)) return layout
  const target = (targetGroupId && findGroup(layout, targetGroupId)) || listGroups(layout.root)[0]!
  const root = mapGroups(layout.root, (group) => group.id === target.id
    ? { ...group, views: [...group.views, view], active: view }
    : group)
  return normalizeLayout({ ...layout, root, hidden: layout.hidden.filter((item) => item !== view) })
}

/** Move a visible view into another group as its active tab. */
export function moveView(layout: ReaderLayout, view: ReaderViewId, targetGroupId: string, index?: number): ReaderLayout {
  const source = groupOfView(layout, view)
  const target = findGroup(layout, targetGroupId)
  if (!source || !target) return layout
  if (source.id === target.id) return activateView(layout, view)
  const removed = removeView(layout.root, view)
  if (!removed) return layout
  const root = mapGroups(removed, (group) => {
    if (group.id !== targetGroupId) return group
    const views = [...group.views]
    views.splice(index === undefined ? views.length : Math.max(0, Math.min(views.length, index)), 0, view)
    return { ...group, views, active: view }
  })
  return normalizeLayout({ ...layout, root })
}

/**
 * Put a view in a new group beside `targetGroupId`. Splitting a group's only
 * view next to itself is a no-op because the view cannot be duplicated.
 */
export function splitView(layout: ReaderLayout, view: ReaderViewId, targetGroupId: string, side: SplitSide): ReaderLayout {
  const source = groupOfView(layout, view)
  if (!source || !findGroup(layout, targetGroupId)) return layout
  if (source.id === targetGroupId && source.views.length === 1) return layout
  const removed = removeView(layout.root, view)
  if (!removed || !listGroups(removed).some((group) => group.id === targetGroupId)) return layout
  const groupId = nextId(layout, 'g')
  const created: LayoutGroup = { kind: 'group', id: groupId, views: [view], active: view }
  const direction: SplitDirection = side === 'left' || side === 'right' ? 'row' : 'column'
  const before = side === 'left' || side === 'top'
  const parent = findParent(removed, targetGroupId)
  let root: LayoutNode
  if (parent && parent.direction === direction) {
    // Share the target's slot with the new group instead of nesting another split.
    root = mapSplits(removed, (split) => {
      if (split.id !== parent.id) return split
      const at = split.children.findIndex((child) => child.id === targetGroupId)
      const half = split.sizes[at]! / 2
      const children = [...split.children]
      const sizes = [...split.sizes]
      children.splice(before ? at : at + 1, 0, created)
      sizes.splice(at, 1, half, half)
      return { ...split, children, sizes }
    })
  } else {
    const splitId = nextId(layout, 's')
    root = replaceNode(removed, targetGroupId, (target) => ({
      kind: 'split',
      id: splitId,
      direction,
      sizes: [50, 50],
      children: before ? [created, target] : [target, created]
    }))
  }
  return normalizeLayout({ ...layout, root })
}

/** Replace the sizes of one split (e.g. after dragging a divider). */
export function resizeSplit(layout: ReaderLayout, splitId: string, sizes: readonly number[]): ReaderLayout {
  return withRoot(layout, mapSplits(layout.root, (split) => split.id === splitId && sizes.length === split.children.length
    ? { ...split, sizes: normalizeSizes(sizes) }
    : split))
}

export function equalizeSplit(layout: ReaderLayout, splitId: string): ReaderLayout {
  return withRoot(layout, mapSplits(layout.root, (split) => split.id === splitId
    ? { ...split, sizes: split.children.map(() => 100 / split.children.length) }
    : split))
}

/** The split that directly contains a node, if any. */
export function parentSplitId(layout: ReaderLayout, nodeId: string): string | undefined {
  return findParent(layout.root, nodeId)?.id
}

// ── Normalization & persistence ──────────────────────────────────────────

/**
 * Repair any layout (including untrusted stored JSON): unknown and duplicate
 * views are dropped, missing views become hidden, empty groups disappear,
 * single-child splits collapse, nested same-direction splits are flattened,
 * and sizes are made positive and summing to 100.
 */
export function normalizeLayout(input: unknown): ReaderLayout {
  if (!isRecord(input) || input.version !== 1) return defaultReaderLayout()
  const seen = new Set<ReaderViewId>()
  const ids = new Set<string>()
  let counter = 0
  const freshId = (prefix: string, candidate: unknown): string => {
    let id = typeof candidate === 'string' && /^[a-z][\w-]{0,31}$/u.test(candidate) && !ids.has(candidate) ? candidate : ''
    while (!id || ids.has(id)) id = `${prefix}${++counter}x`
    ids.add(id)
    return id
  }
  const repair = (node: unknown, depth: number): LayoutNode | null => {
    if (!isRecord(node) || depth > 8) return null
    if (node.kind === 'group') {
      const views = (Array.isArray(node.views) ? node.views : []).filter((view): view is ReaderViewId => {
        if (!isViewId(view) || seen.has(view)) return false
        seen.add(view)
        return true
      })
      if (views.length === 0) return null
      const active = isViewId(node.active) && views.includes(node.active) ? node.active : views[0]!
      return { kind: 'group', id: freshId('g', node.id), views, active }
    }
    if (node.kind !== 'split' || (node.direction !== 'row' && node.direction !== 'column')) return null
    const rawChildren = Array.isArray(node.children) ? node.children : []
    const rawSizes = Array.isArray(node.sizes) ? node.sizes : []
    const children: LayoutNode[] = []
    const sizes: number[] = []
    rawChildren.forEach((child, index) => {
      const repaired = repair(child, depth + 1)
      if (!repaired) return
      const size = typeof rawSizes[index] === 'number' && Number.isFinite(rawSizes[index]) && rawSizes[index] > 0 ? rawSizes[index] as number : 0
      if (repaired.kind === 'split' && repaired.direction === node.direction) {
        // Flatten: a row inside a row is just more columns.
        const share = size || 100 / rawChildren.length
        repaired.children.forEach((grandchild, grandIndex) => {
          children.push(grandchild)
          sizes.push(share * repaired.sizes[grandIndex]! / 100)
        })
        return
      }
      children.push(repaired)
      sizes.push(size)
    })
    if (children.length === 0) return null
    if (children.length === 1) return children[0]!
    return { kind: 'split', id: freshId('s', node.id), direction: node.direction, children, sizes: normalizeSizes(sizes) }
  }
  const root = repair(input.root, 0)
  if (!root) return defaultReaderLayout()
  const storedHidden = Array.isArray(input.hidden) ? input.hidden.filter(isViewId) : []
  const hidden = [...new Set(storedHidden)].filter((view) => !seen.has(view))
  for (const view of READER_VIEW_IDS) if (!seen.has(view) && !hidden.includes(view)) hidden.push(view)
  return { version: 1, root, hidden }
}

export function loadReaderLayout(): ReaderLayout {
  try {
    const stored = window.localStorage.getItem(LAYOUT_STORAGE_KEY)
    if (stored) return normalizeLayout(JSON.parse(stored))
  } catch {
    // Corrupt or unavailable storage falls back to the default layout.
  }
  let legacy = Number.NaN
  try {
    const value = window.sessionStorage.getItem(LEGACY_SPLIT_KEY)
    if (value !== null && value.trim() !== '') legacy = Number(value)
  } catch {
    // Ignore unavailable session storage.
  }
  return defaultReaderLayout(legacy)
}

export function saveReaderLayout(layout: ReaderLayout): void {
  try {
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout))
  } catch {
    // The layout is a convenience; failing to persist it is harmless.
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function withRoot(layout: ReaderLayout, root: LayoutNode): ReaderLayout {
  return root === layout.root ? layout : { ...layout, root }
}

function mapGroups(node: LayoutNode, update: (group: LayoutGroup) => LayoutGroup): LayoutNode {
  if (node.kind === 'group') return update(node)
  let changed = false
  const children = node.children.map((child) => {
    const next = mapGroups(child, update)
    if (next !== child) changed = true
    return next
  })
  return changed ? { ...node, children } : node
}

function mapSplits(node: LayoutNode, update: (split: LayoutSplit) => LayoutSplit): LayoutNode {
  if (node.kind === 'group') return node
  let changed = false
  const children = node.children.map((child) => {
    const next = mapSplits(child, update)
    if (next !== child) changed = true
    return next
  })
  const current = changed ? { ...node, children } : node
  return update(current)
}

function replaceNode(node: LayoutNode, id: string, replace: (node: LayoutNode) => LayoutNode): LayoutNode {
  if (node.id === id) return replace(node)
  if (node.kind === 'group') return node
  return { ...node, children: node.children.map((child) => replaceNode(child, id, replace)) }
}

/** Remove a view from its group, dropping the group if it becomes empty. */
function removeView(node: LayoutNode, view: ReaderViewId): LayoutNode | null {
  if (node.kind === 'group') {
    if (!node.views.includes(view)) return node
    const views = node.views.filter((item) => item !== view)
    if (views.length === 0) return null
    return { ...node, views, active: node.active === view ? views[Math.max(0, node.views.indexOf(view) - 1)]! : node.active }
  }
  const children: LayoutNode[] = []
  const sizes: number[] = []
  node.children.forEach((child, index) => {
    const next = removeView(child, view)
    if (next) {
      children.push(next)
      sizes.push(node.sizes[index]!)
    }
  })
  if (children.length === 0) return null
  if (children.length === 1) return children[0]!
  return { ...node, children, sizes: normalizeSizes(sizes) }
}

function normalizeSizes(sizes: readonly number[]): number[] {
  const safe = sizes.map((size) => Number.isFinite(size) && size > 0 ? size : 0)
  const filled = safe.map((size) => size || (100 / safe.length))
  const total = filled.reduce((sum, size) => sum + size, 0)
  return filled.map((size) => size / total * 100)
}

function nextId(layout: ReaderLayout, prefix: 'g' | 's'): string {
  const used = new Set<string>()
  const collect = (node: LayoutNode): void => {
    used.add(node.id)
    if (node.kind === 'split') node.children.forEach(collect)
  }
  collect(layout.root)
  let index = used.size + 1
  while (used.has(`${prefix}${index}`)) index += 1
  return `${prefix}${index}`
}

function isViewId(value: unknown): value is ReaderViewId {
  return typeof value === 'string' && (READER_VIEW_IDS as readonly string[]).includes(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
