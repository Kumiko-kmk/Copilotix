// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BlockMapping } from '@shared/types'
import { pdfSyncPosition } from '../src/renderer/components/PdfPane'
import { createScrollSyncHub, trackScrollIntent } from '../src/renderer/readerScrollSync'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('scroll sync hub', () => {
  it('sends the leader position to the other synced views once per frame', () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
    const hub = createScrollSyncHub()
    const original = vi.fn()
    const translated = vi.fn()
    const pdf = vi.fn()
    hub.channel('original').register(original)
    hub.channel('translated').register(translated)
    hub.channel('pdf').register(pdf)
    hub.setParticipants(['original', 'translated'])

    hub.channel('original').report({ mappingId: 'a', fraction: 0.1 })
    hub.channel('original').report({ mappingId: 'b', fraction: 0.4 })
    expect(frames).toHaveLength(1)
    frames.shift()!(0)

    expect(translated).toHaveBeenCalledTimes(1)
    expect(translated).toHaveBeenCalledWith({ mappingId: 'b', fraction: 0.4 })
    expect(original).not.toHaveBeenCalled()
    // PDF is not synced, so it neither follows nor leads.
    expect(pdf).not.toHaveBeenCalled()
    hub.channel('pdf').report({ mappingId: 'c', fraction: 0 })
    expect(frames).toHaveLength(0)
  })

  it('stops delivering to unregistered views and after dispose', () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
    const hub = createScrollSyncHub()
    const follow = vi.fn()
    const unregister = hub.channel('translated').register(follow)
    hub.setParticipants(['original', 'translated'])
    unregister()
    hub.channel('original').report({ mappingId: 'a', fraction: 0 })
    expect(follow).not.toHaveBeenCalled()
  })
})

describe('scroll intent', () => {
  it('treats scrolling right after user input as leading, and follow echoes as not', () => {
    let now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const element = document.createElement('div')
    const intent = trackScrollIntent(element)
    expect(intent.isUserScroll()).toBe(false)

    element.dispatchEvent(new WheelEvent('wheel'))
    expect(intent.isUserScroll()).toBe(true)
    now += 1000
    expect(intent.isUserScroll()).toBe(false)

    element.dispatchEvent(new Event('pointerdown'))
    now += 5000
    // Dragging a scrollbar or minimap keeps leading while the pointer is held.
    expect(intent.isUserScroll()).toBe(true)
    intent.markProgrammatic()
    expect(intent.isUserScroll()).toBe(false)
    window.dispatchEvent(new Event('pointerup'))
    now += 200
    expect(intent.isUserScroll()).toBe(true)
    intent.dispose()
  })
})

describe('PDF reading-line block', () => {
  const layout = { pages: [{ top: 0, width: 600, height: 1000 }, { top: 1000, width: 600, height: 1000 }], totalHeight: 2000 }
  const mapping = (id: string, pageIndex: number, top: number, bottom: number): BlockMapping => ({
    id, order: 0, type: 'text', sourceText: id,
    boxes: [{ pageIndex, bbox: [0, top, 600, bottom], pageSize: [600, 1000], blockPosition: `${id}-0` }]
  })

  it('reports the block under the reading line and how far through it', () => {
    const pages = [[mapping('title', 0, 100, 200), mapping('body', 0, 300, 700)], [mapping('next', 1, 0, 400)]]
    expect(pdfSyncPosition(layout, pages, 400)).toEqual({ mappingId: 'body', fraction: expect.closeTo(0.25) })
    expect(pdfSyncPosition(layout, pages, 1200)).toEqual({ mappingId: 'next', fraction: 0.5 })
    // Between blocks: the nearest block, clamped to its edge.
    expect(pdfSyncPosition(layout, pages, 250)).toEqual({ mappingId: 'title', fraction: 1 })
    expect(pdfSyncPosition({ pages: [], totalHeight: 0 }, [], 0)).toBeNull()
  })
})
