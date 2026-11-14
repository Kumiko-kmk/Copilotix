import React from 'react'
import { createPortal } from 'react-dom'
import { CloseOutlined, DisconnectOutlined, LayoutOutlined, LinkOutlined, PlusOutlined, ShrinkOutlined } from '@ant-design/icons'
import { Dropdown, type MenuProps } from 'antd'
import { READING_VIEW_IDS, listGroups, parentSplitId, visibleViews, type LayoutGroup, type LayoutNode, type LayoutSplit, type ReaderViewId, type SplitSide } from '../readerLayout'
import type { ReaderViewSpecs } from './ReaderViews'
import { MIN_GROUP_WIDTH, MIN_GROUP_HEIGHT, minNodeExtent, type DropZone } from './workbenchDrop'
import { SHORTCUT_VIEWS, DragContext, useWorkbench } from './workbenchContext'

/** The workbench's recursive split and group views, drop previews and drag ghost. */

export const KEYBOARD_STEP_PERCENT = 2

export function NodeView(props: { node: LayoutNode }): React.JSX.Element {
  return props.node.kind === 'group' ? <GroupView group={props.node} /> : <SplitView split={props.node} />
}

// Children keep their identity while a divider or tab is dragged, so readers do not re-render per pointer move.
export const MemoNodeView = React.memo(NodeView)

// ── Splits and dividers ──────────────────────────────────────────────────

export function SplitView(props: { split: LayoutSplit }): React.JSX.Element {
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

export function GroupView(props: { group: LayoutGroup }): React.JSX.Element {
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
                    <button type="button" className="reader-tab-close" aria-label={`关闭 ${spec.label}`} onClick={() => actions.hide(view)}>
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
              <button type="button" className="reader-group-button reader-tab-add" aria-label="打开已关闭的视图">
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
            onClick={() => actions.toggleSync(group.active)}
          >
            {synced ? <LinkOutlined /> : <DisconnectOutlined />}
          </button>
        ) : null}
        {maximized ? (
          <button type="button" className="reader-group-button" aria-label="还原分组" onClick={() => actions.toggleMaximize(group.id)}>
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
          <button type="button" className="reader-group-button reader-group-more" aria-label="布局操作">
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

export const ZONE_LABELS: Record<DropZone, string> = {
  center: '移到此分组', left: '在左侧拆分', right: '在右侧拆分', top: '在上方拆分', bottom: '在下方拆分'
}

export function DropPreview(props: { groupId: string }): React.JSX.Element | null {
  const drag = React.useContext(DragContext)
  const target = drag?.target
  if (!target || target.kind !== 'zone' || target.groupId !== props.groupId) return null
  return (
    <div className={`reader-drop-preview zone-${target.zone}${target.allowed ? '' : ' blocked'}`} aria-hidden="true">
      <span>{target.allowed ? ZONE_LABELS[target.zone] : target.reason ?? '无法放置'}</span>
    </div>
  )
}

export function TabDropMarker(props: { groupId: string; barRef: React.RefObject<HTMLDivElement | null> }): React.JSX.Element | null {
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

export function DragGhost(): React.JSX.Element | null {
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

export function MenuLabel(props: { text: string; keys?: string }): React.JSX.Element {
  return (
    <span className="reader-menu-label">
      <span>{props.text}</span>
      {props.keys ? <kbd>{props.keys}</kbd> : null}
    </span>
  )
}

export function nodeLabel(node: LayoutNode, specs: ReaderViewSpecs): string {
  return listGroups(node).map((group) => specs[group.active]?.label ?? group.active).join('、')
}

export function groupLabel(group: LayoutGroup, groups: LayoutGroup[], specs: ReaderViewSpecs): string {
  const names = group.views.map((view) => specs[view]?.label ?? view).join('、')
  return `分组 ${groups.indexOf(group) + 1}（${names}）`
}
