import React from 'react'
import { createPortal } from 'react-dom'
import { CloseOutlined, DisconnectOutlined, LayoutOutlined, LinkOutlined, PlusOutlined, ShrinkOutlined } from '@ant-design/icons'
import { Dropdown, type MenuProps } from 'antd'
import {
  activateView,
  adjacentGroup,
  READING_VIEW_IDS,
  defaultReaderLayout,
  ensureReadingView,
  equalizeSplit,
  findGroup,
  groupOfView,
  hideView,
  listGroups,
  moveView,
  parentSplitId,
  resizeSplit,
  revealView,
  splitView,
  toggleSync,
  visibleViews,
  type LayoutGroup,
  type LayoutNode,
  type LayoutSplit,
  type ReaderLayout,
  type ReaderViewId,
  type SplitSide
} from '../readerLayout'
import type { ReaderViewSpecs } from './ReaderViews'

/** Smallest group size a split may produce; below this a reader stops being usable. */
export const MIN_GROUP_WIDTH = 240
export const MIN_GROUP_HEIGHT = 140
const KEYBOARD_STEP_PERCENT = 2
const DRAG_THRESHOLD_PX = 5
/** Ctrl+1…4 order. */
const SHORTCUT_VIEWS: readonly ReaderViewId[] = ['pdf', 'original', 'translated', 'chat']

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

interface Bounds { left: number; top: number; width: number; height: number }

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

type DropTarget =
  | { groupId: string; kind: 'tab'; index: number }
  | { groupId: string; kind: 'zone'; zone: DropZone; allowed: boolean; reason?: string }

interface DragState {
  view: ReaderViewId
  x: number
  y: number
  target: DropTarget | null
}

interface WorkbenchActions {
  activate(view: ReaderViewId): void
  hide(view: ReaderViewId): void
  reveal(view: ReaderViewId, groupId: string): void
  move(view: ReaderViewId, groupId: string, index?: number): void
  split(view: ReaderViewId, groupId: string, side: SplitSide): void
  resize(splitId: string, sizes: number[]): void
  equalize(splitId: string): void
  reset(): void
  focus(groupId: string): void
  toggleMaximize(groupId: string): void
  toggleSync(view: ReaderViewId): void
  beginTabPointer(event: React.PointerEvent<HTMLElement>, view: ReaderViewId): void
  /** True right after a drag ended, so the tab's click does not also select it. */
  consumeDragClick(): boolean
}

interface WorkbenchContextValue {
  layout: ReaderLayout
  specs: ReaderViewSpecs
  actions: WorkbenchActions
  focusedGroupId: string | null
  maximizedGroupId: string | null
  groups: LayoutGroup[]
  visited: ReadonlySet<ReaderViewId>
}

const WorkbenchContext = React.createContext<WorkbenchContextValue | null>(null)
// Drag state changes every frame while dragging; only tiny overlays read it.
const DragContext = React.createContext<DragState | null>(null)

/**
 * Editor-style reader workbench: views live as tabs in groups, and groups are
 * split left/right or top/bottom. Tabs can be dragged onto other groups (tab
 * bar = move, body edges = split, body centre = merge), double-clicked to
 * maximize, and rearranged from menus or keyboard shortcuts.
 */
export default function ReaderWorkbench(props: {
  layout: ReaderLayout
  specs: ReaderViewSpecs
  focusedGroupId: string | null
  onLayoutChange(layout: ReaderLayout): void
  onFocusGroup(groupId: string): void
  /** Bump to make sure a reading view is on screen (e.g. after a chat citation). */
  revealReadingNonce?: number
}): React.JSX.Element {
  const rootRef = React.useRef<HTMLDivElement>(null)
  const layoutRef = React.useRef(props.layout)
  layoutRef.current = props.layout
  const specsRef = React.useRef(props.specs)
  specsRef.current = props.specs
  const changeRef = React.useRef(props.onLayoutChange)
  changeRef.current = props.onLayoutChange
  const focusRef = React.useRef(props.onFocusGroup)
  focusRef.current = props.onFocusGroup
  const focusedRef = React.useRef(props.focusedGroupId)
  focusedRef.current = props.focusedGroupId
  const [maximized, setMaximized] = React.useState<string | null>(null)
  const maximizedRef = React.useRef(maximized)
  maximizedRef.current = maximized
  const [drag, setDrag] = React.useState<DragState | null>(null)
  const dragRef = React.useRef<DragState | null>(null)
  const dragClickRef = React.useRef(false)

  const actions = React.useMemo<WorkbenchActions>(() => {
    /** Apply a layout change and keep keyboard focus on the group now holding `view`. */
    const commit = (next: ReaderLayout, view?: ReaderViewId): void => {
      if (next === layoutRef.current) return
      changeRef.current(next)
      const group = view ? groupOfView(next, view) : undefined
      if (group) focusRef.current(group.id)
    }
    const hitTest = (x: number, y: number, view: ReaderViewId): DropTarget | null => {
      const element = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(x, y) : null
      const groupElement = element?.closest<HTMLElement>('[data-reader-group]')
      if (!groupElement || !rootRef.current?.contains(groupElement)) return null
      const groupId = groupElement.dataset.readerGroup!
      const bar = element!.closest('.reader-group-bar')
      if (bar) {
        const tabs = Array.from(bar.querySelectorAll<HTMLElement>('.reader-tab'))
        const index = tabs.filter((tab) => {
          const bounds = tab.getBoundingClientRect()
          return bounds.left + bounds.width / 2 < x
        }).length
        return { groupId, kind: 'tab', index }
      }
      const body = groupElement.querySelector<HTMLElement>('.reader-group-body')
      if (!body) return null
      const bounds = body.getBoundingClientRect()
      const zone = dropZoneAt(bounds, x, y)
      return { groupId, kind: 'zone', zone, ...dropVerdict(layoutRef.current, view, groupId, zone, bounds) }
    }
    const drop = (state: DragState): void => {
      const target = state.target
      if (!target) return
      const layout = layoutRef.current
      if (target.kind === 'tab') commit(moveView(layout, state.view, target.groupId, target.index), state.view)
      else if (target.allowed) {
        if (target.zone === 'center') commit(moveView(layout, state.view, target.groupId), state.view)
        else commit(splitView(layout, state.view, target.groupId, target.zone), state.view)
      }
    }
    return {
      activate: (view) => commit(activateView(layoutRef.current, view), view),
      hide: (view) => commit(hideView(layoutRef.current, view)),
      reveal: (view, groupId) => commit(revealView(layoutRef.current, view, groupId), view),
      move: (view, groupId, index) => commit(moveView(layoutRef.current, view, groupId, index), view),
      split: (view, groupId, side) => commit(splitView(layoutRef.current, view, groupId, side), view),
      resize: (splitId, sizes) => commit(resizeSplit(layoutRef.current, splitId, sizes)),
      equalize: (splitId) => commit(equalizeSplit(layoutRef.current, splitId)),
      reset: () => {
        setMaximized(null)
        commit(defaultReaderLayout())
      },
      focus: (groupId) => focusRef.current(groupId),
      toggleMaximize: (groupId) => setMaximized((current) => current === groupId ? null : groupId),
      toggleSync: (view) => commit(toggleSync(layoutRef.current, view)),
      consumeDragClick: () => {
        const consumed = dragClickRef.current
        dragClickRef.current = false
        return consumed
      },
      beginTabPointer: (event, view) => {
        if (event.button !== 0) return
        const startX = event.clientX
        const startY = event.clientY
        let dragging = false
        let frame = 0
        let latest = { x: startX, y: startY }
        const update = (): void => {
          frame = 0
          const next: DragState = { view, x: latest.x, y: latest.y, target: hitTest(latest.x, latest.y, view) }
          dragRef.current = next
          setDrag(next)
        }
        const onMove = (move: PointerEvent): void => {
          latest = { x: move.clientX, y: move.clientY }
          if (!dragging) {
            if (Math.hypot(latest.x - startX, latest.y - startY) < DRAG_THRESHOLD_PX) return
            dragging = true
            rootRef.current?.setAttribute('data-dragging-view', view)
            document.body.classList.add('reader-tab-dragging')
          }
          if (!frame) frame = window.requestAnimationFrame(update)
        }
        const finish = (commitDrop: boolean): void => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          window.removeEventListener('pointercancel', onCancel)
          window.removeEventListener('keydown', onKey, true)
          if (frame) window.cancelAnimationFrame(frame)
          if (!dragging) return
          // pointerup → click arrives next on the tab that started the drag.
          dragClickRef.current = true
          window.setTimeout(() => { dragClickRef.current = false }, 0)
          rootRef.current?.removeAttribute('data-dragging-view')
          document.body.classList.remove('reader-tab-dragging')
          if (commitDrop) {
            update()
            if (dragRef.current) drop(dragRef.current)
          }
          dragRef.current = null
          setDrag(null)
        }
        const onUp = (): void => finish(true)
        const onCancel = (): void => finish(false)
        const onKey = (key: KeyboardEvent): void => {
          if (key.key !== 'Escape') return
          key.preventDefault()
          key.stopPropagation()
          finish(false)
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        window.addEventListener('pointercancel', onCancel)
        window.addEventListener('keydown', onKey, true)
      }
    }
  }, [])

  // A chat citation must land somewhere visible: leave a maximized chat and show a reading view.
  React.useEffect(() => {
    if (!props.revealReadingNonce) return
    const layout = layoutRef.current
    const maximizedGroup = maximizedRef.current ? findGroup(layout, maximizedRef.current) : undefined
    if (maximizedGroup && !READING_VIEW_IDS.includes(maximizedGroup.active)) setMaximized(null)
    const available = READING_VIEW_IDS.filter((view) => specsRef.current[view])
    const next = ensureReadingView(layout, available)
    if (next !== layout) changeRef.current(next)
  }, [props.revealReadingNonce])

  // Keyboard shortcuts, active while the reader (and so the workbench) is mounted.
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) return
      const layout = layoutRef.current
      if (!(event.ctrlKey || event.metaKey)) {
        if (event.key === 'Escape' && maximizedRef.current && !isEditable(event.target)) {
          event.preventDefault()
          setMaximized(null)
        }
        return
      }
      const group = (focusedRef.current ? findGroup(layout, focusedRef.current) : undefined)
        ?? groupOfView(layout, 'original')
        ?? listGroups(layout.root)[0]!
      const view = group.active
      const key = event.key.toLowerCase()
      const plain = !event.shiftKey && !event.altKey
      let handled = true
      if (plain && /^[1-4]$/u.test(key)) {
        const target = SHORTCUT_VIEWS[Number(key) - 1]!
        if (!specsRef.current[target]) return
        if (groupOfView(layout, target)) actions.activate(target)
        else actions.reveal(target, group.id)
      } else if (plain && key === '\\') {
        actions.split(view, group.id, 'right')
      } else if (event.altKey && !event.shiftKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        const offset = event.key === 'ArrowLeft' ? -1 : 1
        const neighbour = adjacentGroup(layout, group.id, offset)
        if (neighbour) actions.move(view, neighbour.id)
        else actions.split(view, group.id, offset < 0 ? 'left' : 'right')
      } else if (plain && key === 'w') {
        actions.hide(view)
      } else if (event.shiftKey && !event.altKey && key === 't') {
        const last = layout.hidden.filter((item) => specsRef.current[item]).at(-1)
        if (last) actions.reveal(last, group.id)
      } else if (event.shiftKey && !event.altKey && key === 'm') {
        if (listGroups(layout.root).length > 1) actions.toggleMaximize(group.id)
      } else {
        handled = false
      }
      if (handled) event.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [actions])

  const groups = React.useMemo(() => listGroups(props.layout.root), [props.layout.root])
  const maximizedGroupId = maximized && groups.length > 1 && groups.some((group) => group.id === maximized) ? maximized : null
  // Keep-mounted views (PDF, chat) mount on their first visit and then stay.
  const [visited, setVisited] = React.useState<ReadonlySet<ReaderViewId>>(() => new Set(groups.map((group) => group.active)))
  if (groups.some((group) => !visited.has(group.active))) {
    setVisited(new Set([...visited, ...groups.map((group) => group.active)]))
  }

  const context = React.useMemo<WorkbenchContextValue>(() => ({
    layout: props.layout, specs: props.specs, actions, focusedGroupId: props.focusedGroupId, maximizedGroupId, groups, visited
  }), [actions, groups, maximizedGroupId, props.focusedGroupId, props.layout, props.specs, visited])

  return (
    <WorkbenchContext.Provider value={context}>
      <DragContext.Provider value={drag}>
        <div
          ref={rootRef}
          className={`reader-workbench${groups.length > 1 ? ' multi-group' : ''}${maximizedGroupId ? ' has-maximized' : ''}`}
        >
          <MemoNodeView node={props.layout.root} />
          <DragGhost />
        </div>
      </DragContext.Provider>
    </WorkbenchContext.Provider>
  )
}

function useWorkbench(): WorkbenchContextValue {
  const value = React.useContext(WorkbenchContext)
  if (!value) throw new Error('ReaderWorkbench context is missing')
  return value
}

function NodeView(props: { node: LayoutNode }): React.JSX.Element {
  return props.node.kind === 'group' ? <GroupView group={props.node} /> : <SplitView split={props.node} />
}

// Children keep their identity while a divider or tab is dragged, so readers do not re-render per pointer move.
const MemoNodeView = React.memo(NodeView)

// ── Splits and dividers ──────────────────────────────────────────────────

function SplitView(props: { split: LayoutSplit }): React.JSX.Element {
  const { actions, specs } = useWorkbench()
  const { split } = props
  const containerRef = React.useRef<HTMLDivElement>(null)
  const [draft, setDraft] = React.useState<number[] | null>(null)
  const draftRef = React.useRef<number[] | null>(null)
  const dragIndexRef = React.useRef<number | null>(null)
  const [extent, setExtent] = React.useState(0)
  const row = split.direction === 'row'
  const sizes = draft && draft.length === split.children.length ? draft : split.sizes

  React.useLayoutEffect(() => {
    const container = containerRef.current
    if (!container || typeof ResizeObserver === 'undefined') return
    const measure = (): void => {
      const bounds = container.getBoundingClientRect()
      setExtent(row ? bounds.width : bounds.height)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => observer.disconnect()
  }, [row])

  const minExtents = React.useMemo(
    () => split.children.map((child) => minNodeExtent(child, split.direction)),
    [split.children, split.direction]
  )
  /** A child's minimum as a percentage of this split (10% while unmeasured). */
  const minPercent = React.useCallback(
    (index: number) => extent > 0 ? Math.min(45, minExtents[index]! / extent * 100) : 10,
    [extent, minExtents]
  )

  /** New sizes when the divider before child `index` sits at `position` percent of the split. */
  const sizesAt = React.useCallback((index: number, position: number, base: readonly number[]): number[] => {
    const start = base.slice(0, index - 1).reduce((sum, size) => sum + size, 0)
    const pair = base[index - 1]! + base[index]!
    const before = Math.min(pair - minPercent(index), Math.max(minPercent(index - 1), position - start))
    const next = [...base]
    next[index - 1] = before
    next[index] = pair - before
    return next
  }, [minPercent])

  const updateFromPointer = React.useCallback((clientX: number, clientY: number) => {
    const index = dragIndexRef.current
    const container = containerRef.current
    if (index === null || !container) return
    const bounds = container.getBoundingClientRect()
    const length = row ? bounds.width : bounds.height
    if (length <= 0) return
    const position = ((row ? clientX - bounds.left : clientY - bounds.top) / length) * 100
    const next = sizesAt(index, position, draftRef.current ?? split.sizes)
    draftRef.current = next
    setDraft(next)
  }, [row, sizesAt, split.sizes])

  const finishDrag = React.useCallback(() => {
    if (dragIndexRef.current === null) return
    dragIndexRef.current = null
    const committed = draftRef.current
    draftRef.current = null
    setDraft(null)
    if (committed) actions.resize(split.id, committed)
  }, [actions, split.id])

  return (
    <div ref={containerRef} className={`reader-split ${split.direction}`} data-dragging={draft !== null}>
      {split.children.map((child, index) => {
        const cumulative = sizes.slice(0, index).reduce((sum, size) => sum + size, 0)
        return (
          <React.Fragment key={child.id}>
            {index > 0 ? (
              <div
                className="reader-split-handle"
                role="separator"
                aria-label={`调整 ${nodeLabel(split.children[index - 1]!, specs)} 与 ${nodeLabel(child, specs)} 阅读器${row ? '宽度' : '高度'}`}
                aria-orientation={row ? 'vertical' : 'horizontal'}
                aria-valuemin={Math.round(cumulative - sizes[index - 1]! + minPercent(index - 1))}
                aria-valuemax={Math.round(cumulative + sizes[index]! - minPercent(index))}
                aria-valuenow={Math.round(cumulative)}
                tabIndex={0}
                title="拖动调整大小，双击平均分配"
                onPointerDown={(event) => {
                  event.preventDefault()
                  event.currentTarget.focus()
                  event.currentTarget.setPointerCapture?.(event.pointerId)
                  dragIndexRef.current = index
                  draftRef.current = [...split.sizes]
                  updateFromPointer(event.clientX, event.clientY)
                }}
                onPointerMove={(event) => updateFromPointer(event.clientX, event.clientY)}
                onPointerUp={finishDrag}
                onPointerCancel={finishDrag}
                onLostPointerCapture={finishDrag}
                onDoubleClick={() => actions.equalize(split.id)}
                onKeyDown={(event) => {
                  const keys: Record<string, number> = row
                    ? { ArrowLeft: -KEYBOARD_STEP_PERCENT, ArrowRight: KEYBOARD_STEP_PERCENT }
                    : { ArrowUp: -KEYBOARD_STEP_PERCENT, ArrowDown: KEYBOARD_STEP_PERCENT }
                  let position: number | null = null
                  if (event.key in keys) position = cumulative + keys[event.key]!
                  else if (event.key === 'Home') position = -Infinity
                  else if (event.key === 'End') position = Infinity
                  if (position === null) return
                  event.preventDefault()
                  actions.resize(split.id, sizesAt(index, position, split.sizes))
                }}
              />
            ) : null}
            <div className="reader-split-pane" style={row ? { flexGrow: sizes[index], minWidth: minExtents[index] } : { flexGrow: sizes[index], minHeight: minExtents[index] }}>
              <MemoNodeView node={child} />
            </div>
          </React.Fragment>
        )
      })}
    </div>
  )
}

// ── Groups and tabs ──────────────────────────────────────────────────────

function GroupView(props: { group: LayoutGroup }): React.JSX.Element {
  const { layout, specs, actions, focusedGroupId, maximizedGroupId, groups, visited } = useWorkbench()
  const { group } = props
  const groupRef = React.useRef<HTMLElement>(null)
  const barRef = React.useRef<HTMLDivElement>(null)
  const [actionsHost, setActionsHost] = React.useState<HTMLDivElement | null>(null)
  const [room, setRoom] = React.useState({ row: true, column: true })
  const baseId = React.useId()
  const views = group.views.filter((view) => specs[view])
  const hidden = layout.hidden.filter((view) => specs[view])
  const canHide = visibleViews(layout).filter((view) => specs[view]).length > 1
  const groupIndex = groups.findIndex((item) => item.id === group.id)
  const focused = groups.length > 1 && focusedGroupId === group.id
  const maximized = maximizedGroupId === group.id
  const parentId = parentSplitId(layout, group.id)
  const syncable = READING_VIEW_IDS.includes(group.active) && Boolean(specs[group.active])
  const synced = syncable && layout.synced.includes(group.active)

  const measureRoom = React.useCallback((open: boolean) => {
    if (!open) return
    const bounds = groupRef.current?.getBoundingClientRect()
    // Unmeasured (e.g. jsdom) means "unknown", which must not block splitting.
    setRoom({
      row: !bounds || bounds.width === 0 || bounds.width >= MIN_GROUP_WIDTH * 2,
      column: !bounds || bounds.height === 0 || bounds.height >= MIN_GROUP_HEIGHT * 2
    })
  }, [])

  const splitItems = (view: ReaderViewId): NonNullable<MenuProps['items']> => {
    const single = group.views.length === 1
    return [
      { key: `split:right:${view}`, label: <MenuLabel text="向右拆分" keys={'Ctrl+\\'} />, disabled: single || !room.row },
      { key: `split:bottom:${view}`, label: <MenuLabel text="向下拆分" />, disabled: single || !room.column }
    ]
  }

  const viewItems = (view: ReaderViewId): MenuProps['items'] => {
    const others = groups.filter((item) => item.id !== group.id)
    return [
      ...splitItems(view),
      ...(others.length > 0 ? [{
        key: `move-menu:${view}`,
        label: '移动到分组',
        children: others.map((item) => ({ key: `move:${item.id}:${view}`, label: groupLabel(item, groups, specs) }))
      }] : []),
      { type: 'divider' as const },
      ...(groups.length > 1 ? [{ key: 'maximize', label: <MenuLabel text={maximized ? '还原分组' : '最大化分组'} keys="Ctrl+Shift+M" /> }] : []),
      { key: `hide:${view}`, label: <MenuLabel text="关闭视图" keys="Ctrl+W" />, disabled: !canHide }
    ]
  }

  const onMenuClick: MenuProps['onClick'] = ({ key }) => {
    const [command, argument, view] = key.split(':') as [string, string, ReaderViewId]
    if (command === 'split') actions.split(view, group.id, argument as SplitSide)
    else if (command === 'move') actions.move(view, argument)
    else if (command === 'hide') actions.hide(argument as ReaderViewId)
    else if (command === 'reveal') actions.reveal(argument as ReaderViewId, group.id)
    else if (command === 'equalize' && parentId) actions.equalize(parentId)
    else if (command === 'maximize') actions.toggleMaximize(group.id)
    else if (command === 'reset') actions.reset()
  }

  const selectSibling = (view: ReaderViewId, offset: number): void => {
    const next = views[(views.indexOf(view) + offset + views.length) % views.length]
    if (!next) return
    actions.activate(next)
    groupRef.current?.querySelector<HTMLElement>(`[data-reader-view="${next}"] [role="tab"]`)?.focus()
  }

  return (
    <section
      ref={groupRef}
      className={`reader-group${focused ? ' focused' : ''}${maximized ? ' maximized' : ''}`}
      data-reader-group={group.id}
      aria-label={`阅读分组 ${groupIndex + 1}`}
      onPointerDownCapture={() => actions.focus(group.id)}
      onFocusCapture={() => actions.focus(group.id)}
    >
      <div className="reader-group-bar" ref={barRef}>
        <div className="reader-tabs" role="tablist" aria-label="视图">
          {views.map((view) => {
            const spec = specs[view]!
            const active = view === group.active
            return (
              <Dropdown
                key={view}
                trigger={['contextMenu']}
                menu={{ items: viewItems(view), onClick: onMenuClick }}
                onOpenChange={measureRoom}
              >
                <div className={active ? 'reader-tab active' : 'reader-tab'} data-reader-view={view}>
                  <button
                    type="button"
                    role="tab"
                    id={`${baseId}-tab-${view}`}
                    aria-selected={active}
                    aria-controls={`${baseId}-panel-${view}`}
                    tabIndex={active ? 0 : -1}
                    title={`${spec.label}：拖动可移动或拆分，双击最大化，右键查看更多操作`}
                    onPointerDown={(event) => actions.beginTabPointer(event, view)}
                    onClick={() => {
                      if (actions.consumeDragClick()) return
                      actions.activate(view)
                    }}
                    onDoubleClick={() => {
                      if (groups.length > 1) actions.toggleMaximize(group.id)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'ArrowRight') { event.preventDefault(); selectSibling(view, 1) }
                      if (event.key === 'ArrowLeft') { event.preventDefault(); selectSibling(view, -1) }
                    }}
                  >
                    <span className="reader-tab-icon" aria-hidden="true">{spec.icon}</span>
                    <span className="reader-tab-label">{spec.tab ?? spec.label}</span>
                  </button>
                  {canHide ? (
                    <button type="button" className="reader-tab-close" aria-label={`关闭 ${spec.label}`} title="关闭视图（Ctrl+W，可从 + 重新打开）" onClick={() => actions.hide(view)}>
                      <CloseOutlined />
                    </button>
                  ) : null}
                </div>
              </Dropdown>
            )
          })}
          {hidden.length > 0 ? (
            <Dropdown
              trigger={['click']}
              menu={{
                items: hidden.map((view) => ({
                  key: `reveal:${view}`,
                  icon: specs[view]!.icon,
                  label: <MenuLabel text={specs[view]!.label} keys={`Ctrl+${SHORTCUT_VIEWS.indexOf(view) + 1}`} />
                })),
                onClick: onMenuClick
              }}
            >
              <button type="button" className="reader-group-button reader-tab-add" aria-label="打开已关闭的视图" title="打开已关闭的视图（Ctrl+Shift+T 恢复最近关闭）">
                <PlusOutlined />
              </button>
            </Dropdown>
          ) : null}
        </div>
        <div className="reader-group-actions" ref={setActionsHost} />
        {syncable ? (
          <button
            type="button"
            className={synced ? 'reader-group-button reader-sync-toggle on' : 'reader-group-button reader-sync-toggle'}
            aria-label="滚动同步"
            aria-pressed={synced}
            title={synced ? '滚动同步已开启：与其他开启同步的视图按段落一起滚动' : '滚动同步已关闭：点击后与其他开启同步的视图按段落一起滚动'}
            onClick={() => actions.toggleSync(group.active)}
          >
            {synced ? <LinkOutlined /> : <DisconnectOutlined />}
          </button>
        ) : null}
        {maximized ? (
          <button type="button" className="reader-group-button" aria-label="还原分组" title="还原分组（Esc）" onClick={() => actions.toggleMaximize(group.id)}>
            <ShrinkOutlined />
          </button>
        ) : null}
        <Dropdown
          trigger={['click']}
          onOpenChange={measureRoom}
          menu={{
            items: [
              ...splitItems(group.active),
              { type: 'divider' as const },
              ...(groups.length > 1 ? [{ key: 'maximize', label: <MenuLabel text={maximized ? '还原分组' : '最大化分组'} keys="Ctrl+Shift+M" /> }] : []),
              { key: 'equalize', label: '平均分配大小', disabled: !parentId },
              { key: 'reset', label: '恢复默认布局' }
            ],
            onClick: onMenuClick
          }}
        >
          <button type="button" className="reader-group-button reader-group-more" aria-label="布局操作" title="布局操作">
            <LayoutOutlined />
          </button>
        </Dropdown>
        <TabDropMarker groupId={group.id} barRef={barRef} />
      </div>
      <div className="reader-group-body">
        {views.map((view) => {
          const spec = specs[view]!
          const active = view === group.active
          const mounted = active || (spec.keepMounted === true && visited.has(view))
          return (
            <div
              key={view}
              id={`${baseId}-panel-${view}`}
              role="tabpanel"
              aria-labelledby={`${baseId}-tab-${view}`}
              className={`reader-view-panel ${spec.panelClassName ?? ''} ${active ? 'active' : 'inactive'}`}
              data-reader-tab-panel={view}
              aria-hidden={!active}
              inert={active ? undefined : true}
            >
              {mounted ? spec.render({ active, actionsHost: active ? actionsHost : null }) : null}
            </div>
          )
        })}
        <DropPreview groupId={group.id} />
      </div>
    </section>
  )
}

// ── Drag feedback (the only components that re-render while dragging) ─────

const ZONE_LABELS: Record<DropZone, string> = {
  center: '移到此分组', left: '在左侧拆分', right: '在右侧拆分', top: '在上方拆分', bottom: '在下方拆分'
}

function DropPreview(props: { groupId: string }): React.JSX.Element | null {
  const drag = React.useContext(DragContext)
  const target = drag?.target
  if (!target || target.kind !== 'zone' || target.groupId !== props.groupId) return null
  return (
    <div className={`reader-drop-preview zone-${target.zone}${target.allowed ? '' : ' blocked'}`} aria-hidden="true">
      <span>{target.allowed ? ZONE_LABELS[target.zone] : target.reason ?? '无法放置'}</span>
    </div>
  )
}

function TabDropMarker(props: { groupId: string; barRef: React.RefObject<HTMLDivElement | null> }): React.JSX.Element | null {
  const drag = React.useContext(DragContext)
  const target = drag?.target
  const bar = props.barRef.current
  if (!target || target.kind !== 'tab' || target.groupId !== props.groupId || !bar) return null
  const tabs = Array.from(bar.querySelectorAll<HTMLElement>('.reader-tab'))
  const barBounds = bar.getBoundingClientRect()
  const reference = tabs[target.index]
  const last = tabs.at(-1)
  const x = reference
    ? reference.getBoundingClientRect().left - 2
    : last ? last.getBoundingClientRect().right + 1 : barBounds.left + 14
  return <i className="reader-tab-drop-marker" style={{ left: x - barBounds.left }} aria-hidden="true" />
}

function DragGhost(): React.JSX.Element | null {
  const drag = React.useContext(DragContext)
  const { specs } = useWorkbench()
  if (!drag) return null
  const spec = specs[drag.view]
  if (!spec) return null
  return createPortal(
    <div className="reader-drag-ghost" style={{ left: Math.min(drag.x + 14, window.innerWidth - 200), top: Math.min(drag.y + 12, window.innerHeight - 40) }} aria-hidden="true">
      <span className="reader-tab-icon">{spec.icon}</span>
      {spec.label}
    </div>,
    document.body
  )
}

function MenuLabel(props: { text: string; keys?: string }): React.JSX.Element {
  return (
    <span className="reader-menu-label">
      <span>{props.text}</span>
      {props.keys ? <kbd>{props.keys}</kbd> : null}
    </span>
  )
}

function isEditable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
}

function nodeLabel(node: LayoutNode, specs: ReaderViewSpecs): string {
  return listGroups(node).map((group) => specs[group.active]?.label ?? group.active).join('、')
}

function groupLabel(group: LayoutGroup, groups: LayoutGroup[], specs: ReaderViewSpecs): string {
  const names = group.views.map((view) => specs[view]?.label ?? view).join('、')
  return `分组 ${groups.indexOf(group) + 1}（${names}）`
}
