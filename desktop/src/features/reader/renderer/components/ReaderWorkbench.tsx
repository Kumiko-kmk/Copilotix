import React from 'react'
import { activateView, adjacentGroup, READING_VIEW_IDS, defaultReaderLayout, ensureReadingView, equalizeSplit, findGroup, groupOfView, hideView, listGroups, moveView, resizeSplit, revealView, splitView, toggleSync, type ReaderLayout, type ReaderViewId } from '../readerLayout'
import type { ReaderViewSpecs } from './ReaderViews'
import { dropVerdict, dropZoneAt } from './workbenchDrop'
export { MIN_GROUP_WIDTH, MIN_GROUP_HEIGHT, minNodeExtent, dropZoneAt, dropVerdict } from './workbenchDrop'
export type { DropZone } from './workbenchDrop'
import { SHORTCUT_VIEWS, WorkbenchContext, DragContext, isEditable, type DropTarget, type DragState, type WorkbenchActions, type WorkbenchContextValue } from './workbenchContext'
import { MemoNodeView, DragGhost } from './WorkbenchViews'

const DRAG_THRESHOLD_PX = 5

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
  revealPdfNonce?: number
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
  React.useEffect(() => {
    if (props.revealPdfNonce) setMaximized(null)
  }, [props.revealPdfNonce])

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
