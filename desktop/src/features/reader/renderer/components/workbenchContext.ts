import React from 'react'
import { type LayoutGroup, type ReaderLayout, type ReaderViewId, type SplitSide } from '../readerLayout'
import type { ReaderViewSpecs } from './ReaderViews'
import { type DropZone } from './workbenchDrop'

/** Contexts and helpers shared by the workbench root and its split and group views. */

/** Ctrl+1…4 order. */
export const SHORTCUT_VIEWS: readonly ReaderViewId[] = ['pdf', 'original', 'translated', 'chat']

export type DropTarget =
  | { groupId: string; kind: 'tab'; index: number }
  | { groupId: string; kind: 'zone'; zone: DropZone; allowed: boolean; reason?: string }

export interface DragState {
  view: ReaderViewId
  x: number
  y: number
  target: DropTarget | null
}

export interface WorkbenchActions {
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

export interface WorkbenchContextValue {
  layout: ReaderLayout
  specs: ReaderViewSpecs
  actions: WorkbenchActions
  focusedGroupId: string | null
  maximizedGroupId: string | null
  groups: LayoutGroup[]
  visited: ReadonlySet<ReaderViewId>
}

export const WorkbenchContext = React.createContext<WorkbenchContextValue | null>(null)

// Drag state changes every frame while dragging; only tiny overlays read it.
export const DragContext = React.createContext<DragState | null>(null)

export function useWorkbench(): WorkbenchContextValue {
  const value = React.useContext(WorkbenchContext)
  if (!value) throw new Error('ReaderWorkbench context is missing')
  return value
}

export function isEditable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
}
