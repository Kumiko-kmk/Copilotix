/**
 * Scroll sync between reader views (PDF, original and translated Markdown).
 *
 * Positions are expressed in content terms — a block mapping id plus how far
 * through that block the reading line is — so views with different layouts
 * (PDF pages, reflowed Markdown, a translation of different length) stay
 * aligned paragraph by paragraph. Only scrolling caused by the user's own
 * input in a view leads; programmatic scrolling (following, jumping to a
 * selection) never reports back, so views cannot bounce each other.
 */

import type { ReaderViewId } from './readerLayout'

/** Fraction of the viewport height used as the shared reading line. */
export const SYNC_READING_LINE = 0.35
/** Scroll events this soon after user input count as user scrolling (covers smooth-scroll inertia). */
const USER_INPUT_WINDOW_MS = 450
/** Scroll events this soon after following another view are echoes, not user scrolling. */
const FOLLOW_ECHO_MS = 120

export interface ScrollSyncPosition {
  mappingId: string
  /** 0…1 through the block at the reading line. */
  fraction: number
}

export interface ScrollSyncChannel {
  /** Report the user's reading position; ignored unless this view takes part in sync. */
  report(position: ScrollSyncPosition): void
  /** Receive positions led by other views; returns an unregister function. */
  register(follow: (position: ScrollSyncPosition) => void): () => void
}

export interface ScrollSyncHub {
  channel(view: ReaderViewId): ScrollSyncChannel
  setParticipants(views: Iterable<ReaderViewId>): void
  dispose(): void
}

export function createScrollSyncHub(): ScrollSyncHub {
  const followers = new Map<ReaderViewId, (position: ScrollSyncPosition) => void>()
  let participants = new Set<ReaderViewId>()
  let pending: { view: ReaderViewId; position: ScrollSyncPosition } | null = null
  let frame = 0
  const channels = new Map<ReaderViewId, ScrollSyncChannel>()

  const flush = (): void => {
    frame = 0
    const next = pending
    pending = null
    if (!next || !participants.has(next.view)) return
    for (const [view, follow] of followers) {
      if (view !== next.view && participants.has(view)) follow(next.position)
    }
  }

  return {
    channel(view) {
      let channel = channels.get(view)
      if (!channel) {
        channel = {
          report(position) {
            if (!participants.has(view)) return
            pending = { view, position }
            // One dispatch per frame however fast the leader scrolls.
            if (!frame) frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(flush) : (flush(), 0)
          },
          register(follow) {
            followers.set(view, follow)
            return () => {
              if (followers.get(view) === follow) followers.delete(view)
            }
          }
        }
        channels.set(view, channel)
      }
      return channel
    },
    setParticipants(views) {
      participants = new Set(views)
    },
    dispose() {
      if (frame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
      frame = 0
      pending = null
      followers.clear()
    }
  }
}

/**
 * Tracks whether scroll events on an element are caused by the user (wheel,
 * pointer drag including scrollbars/minimap, keyboard, touch) and whether the
 * element was just scrolled programmatically to follow another view.
 */
export interface ScrollIntent {
  isUserScroll(): boolean
  markProgrammatic(): void
  dispose(): void
}

export function trackScrollIntent(element: HTMLElement): ScrollIntent {
  let lastInput = -Infinity
  let lastProgrammatic = -Infinity
  let pointerHeld = false
  const now = (): number => performance.now()
  const touch = (): void => { lastInput = now() }
  const press = (): void => { pointerHeld = true; touch() }
  const release = (): void => {
    if (!pointerHeld) return
    pointerHeld = false
    touch()
  }
  element.addEventListener('wheel', touch, { passive: true })
  element.addEventListener('touchstart', touch, { passive: true })
  element.addEventListener('keydown', touch)
  element.addEventListener('pointerdown', press)
  window.addEventListener('pointerup', release)
  window.addEventListener('pointercancel', release)
  return {
    isUserScroll: () => (pointerHeld || now() - lastInput < USER_INPUT_WINDOW_MS) && now() - lastProgrammatic > FOLLOW_ECHO_MS,
    markProgrammatic: () => { lastProgrammatic = now() },
    dispose: () => {
      element.removeEventListener('wheel', touch)
      element.removeEventListener('touchstart', touch)
      element.removeEventListener('keydown', touch)
      element.removeEventListener('pointerdown', press)
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
    }
  }
}

export function clampFraction(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
}
