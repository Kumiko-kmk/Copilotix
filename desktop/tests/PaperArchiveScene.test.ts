// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PaperArchiveScene, type ArchivePalette } from '../src/renderer/paperArchive/PaperArchiveScene'
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

async function createArchive(): Promise<void> {
  const host = document.createElement('div')
  Object.defineProperties(host, { clientWidth: { value: 1100 }, clientHeight: { value: 700 } })
  document.body.appendChild(host)
  archive = new PaperArchiveScene({ container: host, palette, reducedMotion: false, onSelect: vi.fn(), onActivate: vi.fn() })
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
