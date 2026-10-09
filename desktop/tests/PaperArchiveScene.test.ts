// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PaperArchiveScene, entryScanTime, type ArchivePalette, type PaperArchiveSceneOptions } from '../src/renderer/paperArchive/PaperArchiveScene'
import { ArchivePlaneMomentum } from '../src/renderer/paperArchive/archiveMotion'
import { buildArchiveColumns } from '../src/renderer/paperArchive/archiveShelves'

// Keep the production scene, simulation and scheduler; replace only GPU and model I/O.
vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>()
  return {
    ...actual,
    WebGLRenderer: class {
      domElement = document.createElement('canvas')
      shadowMap = { enabled: false, type: 0 }
      info = { render: { triangles: 100 } }
      ratio = 1
      setPixelRatio(value: number): void { this.ratio = value }
      getPixelRatio(): number { return this.ratio }
      getContext(): object { return { getExtension: () => null } }
      setSize = vi.fn()
      render = vi.fn()
      compileAsync = vi.fn(async () => undefined)
      dispose = vi.fn()
      forceContextLoss = vi.fn()
    },
    PMREMGenerator: class {
      fromScene(): object { return { texture: new actual.Texture() } }
      dispose(): void { /* No GPU in this fixture. */ }
    }
  }
})
vi.mock('../src/renderer/paperArchive/assets/archive-shell.glb?inline', () => ({ default: 'data:application/octet-stream;base64,' }))
vi.mock('three/examples/jsm/loaders/GLTFLoader.js', async () => {
  const { Group, Mesh, BoxGeometry, MeshStandardMaterial } = await import('three')
  return {
    GLTFLoader: class {
      async parseAsync(): Promise<object> {
        const group = new Group()
        for (const name of ['Frosted_Polymer', 'Ivory_Edges', 'Index_Inlay', 'Titanium_Fasteners', 'Optical_Diffuser']) {
          const material = new MeshStandardMaterial()
          material.name = name
          group.add(new Mesh(new BoxGeometry(5, 3.7, 0.3), material))
        }
        return { scene: group }
      }
    }
  }
})

const palette: ArchivePalette = {
  background: '#ffffff', floor: '#dddddd', card: '#ffffff', cardSelected: '#ffffff',
  edge: '#ffffff', accent: '#5555dd',
  index: { done: '#dddddd', active: '#5555dd', partial: '#ddaa33', failed: '#dd3333', empty: '#dddddd' }
}
let archive: PaperArchiveScene
let frames: Map<number, FrameRequestCallback>
let nextFrame: number

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] })
  frames = new Map()
  nextFrame = 0
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
})
afterEach(() => {
  archive?.dispose()
  document.body.replaceChildren()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function createArchive(options: Partial<PaperArchiveSceneOptions> = {}): Promise<void> {
  const host = document.createElement('div')
  Object.defineProperties(host, { clientWidth: { value: 1100 }, clientHeight: { value: 700 } })
  document.body.appendChild(host)
  archive = new PaperArchiveScene({ container: host, palette, reducedMotion: false, onSelect: vi.fn(), onActivate: vi.fn(), ...options })
  archive.setShelves(buildArchiveColumns(Array.from({ length: 37 }, (_, index) => ({
    id: String(index), displayName: `Paper ${index}`, originalName: `${index}.pdf`, createdAt: '2026-10-07T12:00:00Z',
    workflow: { status: 'completed' as const, progress: 100, activeJobKind: null, error: null }
  }))))
  await Promise.resolve()
  await Promise.resolve()
  expect(host.querySelector('canvas')?.getAttribute('data-archive-state')).toBe('ready')
}

function step(milliseconds: number): void {
  vi.advanceTimersByTime(milliseconds)
  const pending = [...frames]
  frames.clear()
  for (const [, callback] of pending) callback(performance.now())
}

function advance(milliseconds: number): void {
  for (let elapsed = 0; elapsed < milliseconds; elapsed += 1000 / 60) step(1000 / 60)
}

function pointer(canvas: HTMLCanvasElement, type: string, x: number, y = 100): void {
  const event = new Event(type)
  Object.assign(event, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: x, clientY: y })
  canvas.dispatchEvent(event)
}

describe('paper archive detail transitions', () => {
  it('retains the old selection while closing, then applies only the latest search target', async () => {
    const onSelect = vi.fn()
    const onDetailPhase = vi.fn()
    await createArchive({ onSelect, onDetailPhase })
    archive.openDetail()
    advance(2400)
    expect(archive.detailReady).toBe(true)
    const original = onSelect.mock.lastCall?.[1].id
    onSelect.mockClear()
    archive.navigate('row', 1)
    archive.navigate('row', 1)
    expect(onDetailPhase).toHaveBeenLastCalledWith('closing')
    advance(100)
    expect(onSelect).not.toHaveBeenCalled()
    expect(archive.detailOpen).toBe(true)
    archive.focusPaper('36')
    advance(250)
    expect(onSelect).toHaveBeenCalledOnce()
    expect(onSelect.mock.lastCall?.[1].id).toBe('36')
    expect(original).not.toBe('36')
    expect(onDetailPhase).toHaveBeenLastCalledWith('closed')
    expect(archive.detailOpen).toBe(false)
    expect(frames.size).toBeLessThanOrEqual(1)
  })

  it('accumulates navigation without selecting intermediate papers', async () => {
    const onSelect = vi.fn()
    await createArchive({ onSelect })
    archive.openDetail()
    advance(500)
    onSelect.mockClear()
    archive.navigate('row', 1)
    archive.navigate('row', 1)
    advance(350)
    expect(onSelect).toHaveBeenCalledOnce()
    expect(onSelect.mock.lastCall?.[0]).toEqual({ lane: 0, row: 2 })
  })

  it('reopens from its current pose and cancels a queued selection', async () => {
    const onSelect = vi.fn()
    await createArchive({ onSelect })
    archive.openDetail()
    advance(2400)
    onSelect.mockClear()
    archive.navigate('row', 1)
    advance(150)
    const state = archive as unknown as { detail: number; reveal: number }
    const pose = { detail: state.detail, reveal: state.reveal }
    expect(archive.openDetail()).toBe(true)
    expect({ detail: state.detail, reveal: state.reveal }).toEqual(pose)
    advance(2400)
    expect(archive.detailReady).toBe(true)
    expect(onSelect).not.toHaveBeenCalled()
    archive.closeDetail()
    advance(350)
    expect(onSelect).not.toHaveBeenCalled()
    expect(archive.detailOpen).toBe(false)
  })

  it('handles immediate closing, reduced motion and removal of a queued paper', async () => {
    const onSelect = vi.fn()
    await createArchive({ onSelect })
    archive.openDetail()
    archive.closeDetail()
    advance(350)
    expect(archive.detailOpen).toBe(false)
    archive.openDetail()
    archive.focusPaper('36')
    const state = archive as unknown as { shelves: Parameters<PaperArchiveScene['setShelves']>[0] }
    archive.setShelves(state.shelves.map((shelf) => ({ ...shelf, papers: shelf.papers.filter((paper) => paper.id !== '36') })))
    onSelect.mockClear()
    archive.setReducedMotion(true)
    expect(archive.detailOpen).toBe(false)
    expect(onSelect).not.toHaveBeenCalled()
    archive.openDetail()
    archive.focusPaper('5')
    expect(archive.detailOpen).toBe(false)
    expect(onSelect.mock.lastCall?.[1].id).toBe('5')
    archive.dispose()
    expect(frames.size).toBe(0)
  })

  it('never treats detail dragging or pointer cancellation as a click', async () => {
    const onActivate = vi.fn()
    await createArchive({ onActivate })
    archive.openDetail()
    advance(2400)
    const canvas = document.querySelector('canvas')!
    canvas.setPointerCapture = vi.fn()
    canvas.hasPointerCapture = () => false
    canvas.releasePointerCapture = vi.fn()
    const state = archive as unknown as { selected: { lane: number; row: number }; pickCell(): { lane: number; row: number } | null }
    const pick = vi.spyOn(state, 'pickCell').mockImplementation(() => state.selected)
    pointer(canvas, 'pointerdown', 100)
    pointer(canvas, 'pointermove', 130)
    pointer(canvas, 'pointermove', 100)
    pointer(canvas, 'pointerup', 100)
    expect(onActivate).not.toHaveBeenCalled()
    // Even without a delivered pointermove, a displaced release is not a click.
    pointer(canvas, 'pointerdown', 100)
    pointer(canvas, 'pointerup', 130)
    for (const type of ['pointercancel', 'lostpointercapture']) {
      pointer(canvas, 'pointerdown', 100)
      pointer(canvas, type, 100)
      pointer(canvas, 'pointerup', 100)
    }
    expect(onActivate).not.toHaveBeenCalled()
    expect(archive.detailReady).toBe(true)
    pointer(canvas, 'pointerdown', 100)
    pointer(canvas, 'pointerup', 101)
    expect(onActivate).toHaveBeenCalledOnce()
    pick.mockReturnValue(null)
    pointer(canvas, 'pointerdown', 100)
    pointer(canvas, 'pointermove', 130)
    pointer(canvas, 'pointerup', 130)
    expect(archive.detailReady).toBe(true)
    pointer(canvas, 'pointerdown', 100)
    pointer(canvas, 'pointerup', 100)
    expect(archive.detailReady).toBe(false)
    advance(350)
    expect(archive.detailOpen).toBe(false)
  })
})

describe('paper archive scheduling', () => {
  it('stops drag momentum when search focuses a paper', async () => {
    await createArchive()
    const state = archive as unknown as { momentum: ArchivePlaneMomentum | null }
    state.momentum = new ArchivePlaneMomentum({ lane: 0, row: 0 }, { lane: 3, row: 12 })
    expect(archive.focusPaper('36')).toBe(true)
    expect(state.momentum).toBeNull()
    for (let frame = 0; frame < 30; frame++) step(1000 / 60)
    // Activating after the old inertia would have run must still open the search target.
    const activate = vi.fn()
    const options = (archive as unknown as { options: { onActivate: typeof activate } }).options
    options.onActivate = activate
    archive.activate()
    expect(activate).toHaveBeenCalledWith(expect.objectContaining({ id: '36' }))
  })

  it('keeps one frame loop when coasting selects new cells during update', async () => {
    await createArchive()
    // Reproduce the release of a drag; followTrack -> select -> wake runs inside tick.
    const state = archive as unknown as { momentum: ArchivePlaneMomentum | null }
    state.momentum = new ArchivePlaneMomentum({ lane: 0, row: 0 }, { lane: 3, row: 12 })
    for (let frame = 0; frame < 180; frame++) {
      step(1000 / 165)
      expect(frames.size).toBe(1)
    }
    expect(archive.getStats().fps).toBeGreaterThanOrEqual(50)
    expect(archive.getStats().fps).toBeLessThanOrEqual(60)
    archive.dispose()
    expect(frames.size).toBe(0)
  })

  it('wakes idle breathing using wall time while the animation clock is stopped', async () => {
    await createArchive()
    const state = archive as unknown as { clock: number; lastInteraction: number; idleGain: number }
    // Let entry and springs settle without becoming idle, then stop all interaction.
    for (let frame = 0; frame < 600; frame++) {
      state.lastInteraction = performance.now()
      step(1000 / 60)
    }
    expect(frames.size).toBe(0)
    const sleepingClock = state.clock
    vi.advanceTimersByTime(2600)
    expect(state.clock).toBe(sleepingClock)
    expect(frames.size).toBe(1)
    step(1000 / 60)
    expect(state.idleGain).toBeGreaterThan(0)
    expect(frames.size).toBe(1)
  })

  it('does not start idle breathing with reduced motion enabled', async () => {
    await createArchive()
    archive.setReducedMotion(true)
    for (let frame = 0; frame < 600; frame++) step(1000 / 60)
    expect(frames.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('archive entry and detail framing', () => {
  it('shortens only the flat stretch of the entry scan', () => {
    expect(entryScanTime(0.5)).toBe(0.5)
    expect(entryScanTime(3)).toBeCloseTo(4.25)
    let previous = -Infinity
    for (let time = 0; time <= 4; time += 0.01) {
      const scan = entryScanTime(time)
      expect(scan).toBeGreaterThan(previous)
      previous = scan
    }
  })

  it('reports where the extracted card will sit so the panel can match its height', async () => {
    const onDetailFrame = vi.fn()
    await createArchive({ onDetailFrame })
    const frame = onDetailFrame.mock.lastCall?.[0]
    expect(frame.top).toBeGreaterThan(0)
    expect(frame.bottom - frame.top).toBeGreaterThan(300)
    expect(frame.right).toBeLessThan(1100 * 0.6)
  })
})
