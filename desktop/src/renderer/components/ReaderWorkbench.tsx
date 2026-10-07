import React from 'react'
import { CloseOutlined, EllipsisOutlined, PlusOutlined } from '@ant-design/icons'
import { Dropdown, type MenuProps } from 'antd'
import {
  equalizeSplit,
  hideView,
  listGroups,
  moveView,
  parentSplitId,
  resizeSplit,
  revealView,
  splitView,
  activateView,
  defaultReaderLayout,
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

interface WorkbenchActions {
  activate(view: ReaderViewId): void
  hide(view: ReaderViewId): void
  reveal(view: ReaderViewId, groupId: string): void
  move(view: ReaderViewId, groupId: string): void
  split(view: ReaderViewId, groupId: string, side: SplitSide): void
  resize(splitId: string, sizes: number[]): void
  equalize(splitId: string): void
  reset(): void
  focus(groupId: string): void
}

interface WorkbenchContextValue {
  layout: ReaderLayout
  specs: ReaderViewSpecs
  actions: WorkbenchActions
  focusedGroupId: string | null
  groups: LayoutGroup[]
  visited: ReadonlySet<ReaderViewId>
}

const WorkbenchContext = React.createContext<WorkbenchContextValue | null>(null)

/**
 * Editor-style reader workbench: views live as tabs in groups, and groups are
 * split left/right or top/bottom. Phase 1 rearranges through tab context menus,
 * the tab-bar buttons and draggable dividers.
 */
export default function ReaderWorkbench(props: {
  layout: ReaderLayout
  specs: ReaderViewSpecs
  focusedGroupId: string | null
  onLayoutChange(layout: ReaderLayout): void
  onFocusGroup(groupId: string): void
}): React.JSX.Element {
  const layoutRef = React.useRef(props.layout)
  layoutRef.current = props.layout
  const changeRef = React.useRef(props.onLayoutChange)
  changeRef.current = props.onLayoutChange
  const focusRef = React.useRef(props.onFocusGroup)
  focusRef.current = props.onFocusGroup

  const actions = React.useMemo<WorkbenchActions>(() => {
    const apply = (next: ReaderLayout): void => {
      if (next !== layoutRef.current) changeRef.current(next)
    }
    return {
      activate: (view) => apply(activateView(layoutRef.current, view)),
      hide: (view) => apply(hideView(layoutRef.current, view)),
      reveal: (view, groupId) => apply(revealView(layoutRef.current, view, groupId)),
      move: (view, groupId) => apply(moveView(layoutRef.current, view, groupId)),
      split: (view, groupId, side) => apply(splitView(layoutRef.current, view, groupId, side)),
      resize: (splitId, sizes) => apply(resizeSplit(layoutRef.current, splitId, sizes)),
      equalize: (splitId) => apply(equalizeSplit(layoutRef.current, splitId)),
      reset: () => apply(defaultReaderLayout()),
      focus: (groupId) => focusRef.current(groupId)
    }
  }, [])

  const groups = React.useMemo(() => listGroups(props.layout.root), [props.layout.root])
  // Keep-mounted views (PDF, chat) mount on their first visit and then stay.
  const [visited, setVisited] = React.useState<ReadonlySet<ReaderViewId>>(() => new Set(groups.map((group) => group.active)))
  if (groups.some((group) => !visited.has(group.active))) {
    setVisited(new Set([...visited, ...groups.map((group) => group.active)]))
  }

  const context = React.useMemo<WorkbenchContextValue>(() => ({
    layout: props.layout, specs: props.specs, actions, focusedGroupId: props.focusedGroupId, groups, visited
  }), [actions, groups, props.focusedGroupId, props.layout, props.specs, visited])

  return (
    <WorkbenchContext.Provider value={context}>
      <div className={groups.length > 1 ? 'reader-workbench multi-group' : 'reader-workbench'}>
        <NodeView node={props.layout.root} />
      </div>
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

  const minPercent = extent > 0 ? Math.min(45, (row ? MIN_GROUP_WIDTH : MIN_GROUP_HEIGHT) / extent * 100) : 10

  /** New sizes when the divider before child `index` sits at `position` percent of the split. */
  const sizesAt = React.useCallback((index: number, position: number, base: readonly number[]): number[] => {
    const start = base.slice(0, index - 1).reduce((sum, size) => sum + size, 0)
    const pair = base[index - 1]! + base[index]!
    const before = Math.min(pair - minPercent, Math.max(minPercent, position - start))
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
                aria-valuemin={Math.round(cumulative - sizes[index - 1]! + minPercent)}
                aria-valuemax={Math.round(cumulative + sizes[index]! - minPercent)}
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
            <div className="reader-split-pane" style={{ flexGrow: sizes[index] }}>
              <MemoNodeView node={child} />
            </div>
          </React.Fragment>
        )
      })}
    </div>
  )
}

// Children keep their identity while a divider is dragged, so readers do not re-render per pointer move.
const MemoNodeView = React.memo(NodeView)

// ── Groups and tabs ──────────────────────────────────────────────────────

function GroupView(props: { group: LayoutGroup }): React.JSX.Element {
  const { layout, specs, actions, focusedGroupId, groups, visited } = useWorkbench()
  const { group } = props
  const groupRef = React.useRef<HTMLElement>(null)
  const [actionsHost, setActionsHost] = React.useState<HTMLDivElement | null>(null)
  const [room, setRoom] = React.useState({ row: true, column: true })
  const baseId = React.useId()
  const views = group.views.filter((view) => specs[view])
  const hidden = layout.hidden.filter((view) => specs[view])
  const canHide = visibleViews(layout).filter((view) => specs[view]).length > 1
  const groupIndex = groups.findIndex((item) => item.id === group.id)
  const focused = groups.length > 1 && (focusedGroupId === group.id)
  const parentId = parentSplitId(layout, group.id)

  const measureRoom = React.useCallback((open: boolean) => {
    if (!open) return
    const bounds = groupRef.current?.getBoundingClientRect()
    // Unmeasured (e.g. jsdom) means "unknown", which must not block splitting.
    setRoom({
      row: !bounds || bounds.width === 0 || bounds.width >= MIN_GROUP_WIDTH * 2,
      column: !bounds || bounds.height === 0 || bounds.height >= MIN_GROUP_HEIGHT * 2
    })
  }, [])

  const viewItems = (view: ReaderViewId): MenuProps['items'] => {
    const single = group.views.length === 1
    const others = groups.filter((item) => item.id !== group.id)
    return [
      { key: `split:right:${view}`, label: '向右拆分', disabled: single || !room.row },
      { key: `split:bottom:${view}`, label: '向下拆分', disabled: single || !room.column },
      ...(others.length > 0 ? [{
        key: `move-menu:${view}`,
        label: '移动到分组',
        children: others.map((item) => ({ key: `move:${item.id}:${view}`, label: groupLabel(item, groups, specs) }))
      }] : []),
      { type: 'divider' as const },
      { key: `hide:${view}`, label: '关闭视图', disabled: !canHide }
    ]
  }

  const onMenuClick: MenuProps['onClick'] = ({ key }) => {
    const [command, argument, view] = key.split(':') as [string, string, ReaderViewId]
    if (command === 'split') actions.split(view, group.id, argument as SplitSide)
    else if (command === 'move') actions.move(view, argument)
    else if (command === 'hide') actions.hide(argument as ReaderViewId)
    else if (command === 'reveal') actions.reveal(argument as ReaderViewId, group.id)
    else if (command === 'equalize' && parentId) actions.equalize(parentId)
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
      className={focused ? 'reader-group focused' : 'reader-group'}
      data-reader-group={group.id}
      aria-label={`阅读分组 ${groupIndex + 1}`}
      onPointerDownCapture={() => actions.focus(group.id)}
      onFocusCapture={() => actions.focus(group.id)}
    >
      <div className="reader-group-bar">
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
                    title={`${spec.label}（右键查看更多操作）`}
                    onClick={() => actions.activate(view)}
                    onKeyDown={(event) => {
                      if (event.key === 'ArrowRight') { event.preventDefault(); selectSibling(view, 1) }
                      if (event.key === 'ArrowLeft') { event.preventDefault(); selectSibling(view, -1) }
                    }}
                  >
                    <span className="reader-tab-icon" aria-hidden="true">{spec.icon}</span>
                    <span className="reader-tab-label">{spec.tab ?? spec.label}</span>
                  </button>
                  {canHide ? (
                    <button type="button" className="reader-tab-close" aria-label={`关闭 ${spec.label}`} title="关闭视图（可从 + 重新打开）" onClick={() => actions.hide(view)}>
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
                items: hidden.map((view) => ({ key: `reveal:${view}`, icon: specs[view]!.icon, label: specs[view]!.label })),
                onClick: onMenuClick
              }}
            >
              <button type="button" className="reader-group-button reader-tab-add" aria-label="打开已关闭的视图" title="打开已关闭的视图">
                <PlusOutlined />
              </button>
            </Dropdown>
          ) : null}
        </div>
        <div className="reader-group-actions" ref={setActionsHost} />
        <Dropdown
          trigger={['click']}
          onOpenChange={measureRoom}
          menu={{
            items: [
              ...(viewItems(group.active) ?? []).filter((item) => item && 'key' in item && String(item.key).startsWith('split')),
              { type: 'divider' as const },
              { key: 'equalize', label: '平均分配大小', disabled: !parentId },
              { key: 'reset', label: '恢复默认布局' }
            ],
            onClick: onMenuClick
          }}
        >
          <button type="button" className="reader-group-button reader-group-more" aria-label="分组操作" title="分组操作">
            <EllipsisOutlined />
          </button>
        </Dropdown>
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
      </div>
    </section>
  )
}

function nodeLabel(node: LayoutNode, specs: ReaderViewSpecs): string {
  return listGroups(node).map((group) => specs[group.active]?.label ?? group.active).join('、')
}

function groupLabel(group: LayoutGroup, groups: LayoutGroup[], specs: ReaderViewSpecs): string {
  const names = group.views.map((view) => specs[view]?.label ?? view).join('、')
  return `分组 ${groups.indexOf(group) + 1}（${names}）`
}
