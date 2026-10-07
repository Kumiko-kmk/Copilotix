import {
  ACESFilmicToneMapping,
  BoxGeometry,
  Color,
  DirectionalLight,
  DynamicDrawUsage,
  Fog,
  Frustum,
  HemisphereLight,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Quaternion,
  Raycaster,
  Scene,
  Sphere,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
  type BufferGeometry,
  type Material,
  type Texture
} from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import archiveShellUrl from './assets/archive-shell.glb?inline'
import {
  ArchivePlaneMomentum,
  SHOULDER_PEAK,
  archiveWave,
  columnStrength,
  damp,
  idleWave,
  selectionWave,
  settlingWave,
  smooth,
  springSettled,
  type PlanePosition,
  type Spring
} from './archiveMotion'
import {
  cellForPaper,
  laneStep,
  paperAt,
  shelfAt,
  wrap,
  type ArchiveCell,
  type ArchivePaper,
  type ArchiveShelf
} from './archiveShelves'

// Scene, model, materials and lighting follow RhineLabUI (MIT, Copyright (c)
// 2026 LBEILC, https://github.com/LBEILC/RhineLabUI): src/scene.ts and
// src/archive-lighting.ts. The cassette shell is extracted from its
// archive-cassette.glb. Lanes are 5.2 apart, rows 0.62 apart, and a 59° / 19°
// camera at a long distance with a narrow field of view frames the array.
const COLUMN_SPACING = 5.2
const ROW_SPACING = 0.62
const CARD_HEIGHT = 3.7
const BASE_Y = -4.6
const RAIL_OFFSET = -2.17
const PREVIEW_LIFT = 0.4
const HOVER_LIFT = 0.28
const CAMERA_DISTANCE = 140
const CAMERA_YAW = (59 * Math.PI) / 180
const CAMERA_ELEVATION = (19 * Math.PI) / 180
const VIEW_SPAN = 7.33
const ARRAY_AIM = new Vector3(-1.091, -0.045, 0.481)
const LANE_RADIUS = 4
const ROW_RADIUS = 30
const POOL_SIZE = (LANE_RADIUS * 2 + 1) * (ROW_RADIUS * 2 + 1)
const CARD_RADIUS = 3.4
const IDLE_DELAY = 2.5
const IDLE_FRAME_INTERVAL = 1 / 30
const ENTRY_DURATION = 4.35
const SHELL_SURFACES = ['Frosted_Polymer', 'Ivory_Edges', 'Index_Inlay', 'Titanium_Fasteners', 'Optical_Diffuser'] as const
type ShellSurface = typeof SHELL_SURFACES[number]

export interface ArchivePalette {
  background: string
  floor: string
  card: string
  cardSelected: string
  edge: string
  accent: string
  index: Record<'done' | 'active' | 'partial' | 'failed' | 'empty', string>
}

export interface PaperArchiveSceneOptions {
  container: HTMLElement
  palette: ArchivePalette
  reducedMotion: boolean
  /** The selected cell changed (drag, wheel, click or keyboard). */
  onSelect(cell: ArchiveCell, paper: ArchivePaper | null): void
  /** The selected card was clicked again or double-clicked. */
  onActivate(paper: ArchivePaper): void
  /** The model could not be prepared; the page shows a fallback. */
  onError?(error: unknown): void
}

type Pulse = { row: number; lane: number; time: number }

const cellKey = (cell: ArchiveCell): string => `${cell.lane}:${cell.row}`
const sameCell = (a: ArchiveCell, b: ArchiveCell): boolean => a.lane === b.lane && a.row === b.row

function indexTone(paper: ArchivePaper | null): keyof ArchivePalette['index'] {
  if (!paper) return 'empty'
  const status = paper.workflow.status
  if (status === 'completed') return 'done'
  if (status === 'failed') return 'failed'
  if (status === 'partial') return 'partial'
  return 'active'
}

function decodeInlineAsset(url: string): ArrayBuffer {
  const binary = atob(url.slice(url.indexOf(',') + 1))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes.buffer
}

export class PaperArchiveScene {
  private readonly options: PaperArchiveSceneOptions
  private readonly renderer: WebGLRenderer
  private readonly scene = new Scene()
  private readonly camera = new PerspectiveCamera(3, 1, 100, 200)
  private readonly frustum = new Frustum()
  private readonly surfaces = new Map<ShellSurface, InstancedMesh>()
  private readonly strip: Mesh
  private readonly floor: Mesh
  private readonly environment: Texture
  private readonly disposables: Array<BufferGeometry | Material | Texture> = []
  private readonly events = new AbortController()
  private readonly resizeObserver: ResizeObserver
  private readonly raycaster = new Raycaster()
  private readonly palette = { card: new Color(), cardSelected: new Color(), index: new Map<string, Color>() }

  private shelves: ArchiveShelf[] = []
  private memory = new Map<string, string>()
  private selected: ArchiveCell = { lane: 0, row: 0 }
  /** Cells drawn this frame, in instance order; picking maps instance ids through it. */
  private drawn: ArchiveCell[] = Array.from({ length: POOL_SIZE }, () => ({ lane: 0, row: 0 }))
  private drawnCount = 0

  // Track position of the camera over the plane, in cell units.
  private laneTrack: Spring = { value: 0, velocity: 0 }
  private rowTrack: Spring = { value: 0, velocity: 0 }
  private shoulder: Spring = { value: 0, velocity: 0 }
  private laneFocus: Spring = { value: 0, velocity: 0 }
  private lifts = new Map<string, Spring>()
  private hoverLifts = new Map<string, number>()
  private hoverCell: ArchiveCell | null = null
  private pendingHover: { x: number; y: number } | null = null
  private pulses: Pulse[] = []
  private pendingPulse: ArchiveCell | null = null
  private momentum: ArchivePlaneMomentum | null = null
  private drag: {
    pointerId: number
    startX: number
    startY: number
    start: PlanePosition
    inverse: { lane: Vector2; row: Vector2 } | null
    active: boolean
    samples: Array<{ value: PlanePosition; time: number }>
  } | null = null

  private reduced: boolean
  private loaded = false
  private focused = document.hasFocus()
  private clock = 0
  private entryTime = 0
  private idleGain = 0
  private lastInteraction = 0
  private lastFrame = 0
  private lastRender = -Infinity
  private frame = 0
  private idleTimer = 0
  private disposed = false

  constructor(options: PaperArchiveSceneOptions) {
    this.options = options
    this.reduced = options.reducedMotion
    this.renderer = new WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' })
    this.renderer.outputColorSpace = SRGBColorSpace
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = PCFSoftShadowMap
    this.renderer.toneMapping = ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05
    const canvas = this.renderer.domElement
    canvas.className = 'paper-archive-canvas'
    canvas.setAttribute('aria-hidden', 'true')
    options.container.appendChild(canvas)

    // Studio illumination from RhineLabUI's archive-lighting.ts (baseline look).
    const pmrem = new PMREMGenerator(this.renderer)
    const room = new RoomEnvironment()
    this.environment = pmrem.fromScene(room, 0.04).texture
    room.dispose()
    pmrem.dispose()
    this.scene.environment = this.environment
    this.scene.environmentIntensity = 0.48
    this.scene.add(new HemisphereLight('#fffaf5', '#b4a18c', 0.65))
    const key = new DirectionalLight('#fff7ed', 1.4)
    key.position.set(-6, 14, -5)
    key.castShadow = true
    Object.assign(key.shadow.camera, { left: -16, right: 16, top: 15, bottom: -15, near: 0.1, far: 45 })
    key.shadow.mapSize.set(2048, 2048)
    key.shadow.normalBias = 0.035
    key.shadow.bias = -0.0003
    key.shadow.radius = 4
    const fill = new DirectionalLight('#ffffff', 0.6)
    fill.position.set(7, 8, -10)
    this.scene.add(key, fill)
    this.scene.fog = new Fog(0xffffff, CAMERA_DISTANCE + 5, CAMERA_DISTANCE + 25)

    const floorGeometry = new PlaneGeometry(200, 200)
    const floorMaterial = new MeshStandardMaterial({ roughness: 0.95 })
    this.floor = new Mesh(floorGeometry, floorMaterial)
    this.floor.rotation.x = -Math.PI / 2
    this.floor.position.y = BASE_Y - 0.03
    this.floor.receiveShadow = true
    this.scene.add(this.floor)

    const stripGeometry = new BoxGeometry(4.3, 0.045, 0.02)
    stripGeometry.translate(0.05, CARD_HEIGHT - 0.12, 0.225)
    const stripMaterial = new MeshBasicMaterial({ transparent: true, toneMapped: false })
    this.strip = new Mesh(stripGeometry, stripMaterial)
    this.strip.visible = false
    this.scene.add(this.strip)
    this.disposables.push(this.environment, floorGeometry, floorMaterial, stripGeometry, stripMaterial)
    this.setPalette(options.palette)

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(options.container)
    this.resize()
    this.bindInput(canvas)
    void this.load()
  }

  private async load(): Promise<void> {
    try {
      const gltf = await new GLTFLoader().parseAsync(decodeInlineAsset(archiveShellUrl), '')
      if (this.disposed) return
      gltf.scene.updateMatrixWorld(true)
      let sharedMatrix: InstancedMesh['instanceMatrix'] | null = null
      gltf.scene.traverse((object) => {
        if (!(object instanceof Mesh)) return
        const source = object.material as MeshStandardMaterial
        const name = source.name.replace(/\.\d+$/, '') as ShellSurface
        if (!SHELL_SURFACES.includes(name)) return
        const geometry = (object.geometry as BufferGeometry).clone().applyMatrix4(object.matrixWorld)
        const material = this.arrayMaterial(name, source)
        const mesh = new InstancedMesh(geometry, material, POOL_SIZE)
        // All surfaces move rigidly together; share one transform buffer on the GPU.
        sharedMatrix ??= mesh.instanceMatrix.setUsage(DynamicDrawUsage)
        mesh.instanceMatrix = sharedMatrix
        mesh.count = 0
        mesh.frustumCulled = false
        mesh.receiveShadow = true
        // Only the small inner diffuser casts the array's shadow, as in the original.
        mesh.castShadow = name === 'Optical_Diffuser'
        this.surfaces.set(name, mesh)
        this.disposables.push(geometry, material)
        this.scene.add(mesh)
      })
      gltf.scene.traverse((object) => {
        if (!(object instanceof Mesh)) return
        object.geometry.dispose()
        ;(object.material as Material).dispose()
      })
      if (!this.surfaces.has('Frosted_Polymer')) throw new Error('archive shell is missing its cover')
      this.applyPalette()
      this.loaded = true
      this.entryTime = this.reduced ? this.clock - ENTRY_DURATION - 2 : this.clock
      this.lastInteraction = this.clock
      this.wake()
    } catch (error) {
      if (!this.disposed) this.options.onError?.(error)
    }
  }

  /** Array materials from RhineLabUI's baseline look. */
  private arrayMaterial(name: ShellSurface, source: MeshStandardMaterial): Material {
    if (name === 'Frosted_Polymer') {
      // Transmission shows the darker diffuser and the neighbouring files through each cover,
      // which is what makes the crests readable. The array is only redrawn while it moves.
      const material = new MeshPhysicalMaterial({
        roughness: 0.28, metalness: 0, transmission: 0.78, ior: 1.46,
        clearcoat: 0.3, clearcoatRoughness: 0.25, envMapIntensity: 0.6
      })
      material.onBeforeCompile = (shader) => {
        // Shade each cover from its foot to its top so the rows read as a surface of crests and troughs.
        shader.vertexShader = 'varying float vPanelHeight;\n' + shader.vertexShader.replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>\nvPanelHeight = position.y / ${CARD_HEIGHT.toFixed(1)};`
        )
        shader.fragmentShader = 'varying float vPanelHeight;\n' + shader.fragmentShader.replace(
          '#include <color_fragment>',
          '#include <color_fragment>\ndiffuseColor.rgb *= mix(vec3(0.40, 0.30, 0.20), vec3(1.0, 0.98, 0.94), smoothstep(0.1, 1.0, vPanelHeight));'
        )
      }
      material.customProgramCacheKey = () => 'paper-archive-frosted'
      return material
    }
    if (name === 'Ivory_Edges') return new MeshStandardMaterial({ roughness: 0.38, metalness: 0, envMapIntensity: 0.6 })
    if (name === 'Index_Inlay') return new MeshStandardMaterial({ roughness: 0.5, metalness: 0.05, envMapIntensity: 0.6 })
    if (name === 'Optical_Diffuser') return new MeshStandardMaterial({ color: '#806447', roughness: 0.7 })
    const material = source.clone()
    material.envMapIntensity = 0.6
    return material
  }

  setPalette(palette: ArchivePalette): void {
    const background = new Color(palette.background)
    this.scene.background = background
    ;(this.scene.fog as Fog).color.copy(background)
    ;(this.floor.material as MeshStandardMaterial).color.set(palette.floor)
    this.palette.card.set(palette.card)
    this.palette.cardSelected.set(palette.cardSelected)
    for (const [tone, value] of Object.entries(palette.index)) this.palette.index.set(tone, new Color(value))
    ;(this.strip.material as MeshBasicMaterial).color.set(palette.accent)
    this.edgeColor.set(palette.edge)
    this.applyPalette()
    this.wake()
  }

  private readonly edgeColor = new Color()

  private applyPalette(): void {
    const edges = this.surfaces.get('Ivory_Edges')
    if (edges) (edges.material as MeshStandardMaterial).color.copy(this.edgeColor)
  }

  setReducedMotion(reduced: boolean): void {
    this.reduced = reduced
    this.wake()
  }

  /** Replace the archive contents, keeping the current paper in view when it still exists. */
  setShelves(shelves: ArchiveShelf[]): void {
    const current = paperAt(this.shelves, this.selected)
    this.shelves = shelves
    const keys = new Set(shelves.map((shelf) => shelf.key))
    for (const key of this.memory.keys()) if (!keys.has(key)) this.memory.delete(key)
    const next = current ? cellForPaper(shelves, current.id, this.selected) : null
    if (next && !sameCell(next, this.selected)) this.jumpTo(next)
    this.emitSelection()
    this.wake()
  }

  /** Select a paper by id; returns false when it is not in the archive. */
  focusPaper(paperId: string, options: { instant?: boolean } = {}): boolean {
    const cell = cellForPaper(this.shelves, paperId, this.selected)
    if (!cell) return false
    if (options.instant) {
      this.jumpTo(cell)
      this.emitSelection()
      this.wake()
    } else this.select(cell)
    return true
  }

  navigate(axis: 'lane' | 'row', direction: number): void {
    if (this.drag?.active) return
    this.stopMomentum()
    const target = axis === 'row'
      ? { lane: this.selected.lane, row: this.selected.row + direction }
      : laneStep(this.shelves, this.selected, direction, this.memory)
    this.select(target)
  }

  activate(): void {
    const paper = paperAt(this.shelves, this.selected)
    if (paper) this.options.onActivate(paper)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    cancelAnimationFrame(this.frame)
    window.clearTimeout(this.idleTimer)
    this.events.abort()
    this.resizeObserver.disconnect()
    for (const mesh of this.surfaces.values()) mesh.dispose()
    for (const item of this.disposables) item.dispose()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    this.renderer.domElement.remove()
  }

  private select(cell: ArchiveCell, options: { pulse?: boolean } = {}): void {
    this.lastInteraction = this.clock
    if (sameCell(cell, this.selected)) return
    this.selected = { ...cell }
    this.pendingPulse = options.pulse === false || this.reduced ? null : { ...cell }
    this.emitSelection()
    this.wake()
  }

  /** Re-anchor without travelling through the plane (used when the contents change). */
  private jumpTo(cell: ArchiveCell): void {
    const shift = { lane: cell.lane - this.selected.lane, row: cell.row - this.selected.row }
    this.selected = { ...cell }
    this.laneTrack.value += shift.lane
    this.rowTrack.value += shift.row
    this.shoulder.value += shift.row
    this.laneFocus.value += shift.lane
    this.lifts.clear()
    this.hoverLifts.clear()
    this.pulses = []
    this.pendingPulse = null
  }

  private emitSelection(): void {
    const paper = paperAt(this.shelves, this.selected)
    const shelf = shelfAt(this.shelves, this.selected.lane)
    if (paper && shelf) this.memory.set(shelf.key, paper.id)
    this.options.onSelect({ ...this.selected }, paper)
  }

  private stopMomentum(): void {
    if (!this.momentum) return
    this.momentum = null
    this.laneTrack.velocity = this.rowTrack.velocity = 0
  }

  private resize(): void {
    const { clientWidth: width, clientHeight: height } = this.options.container
    if (!width || !height) return
    this.renderer.setSize(width, height, false)
    const aspect = width / height
    // RhineLabUI's archiveFraming: wide windows extend sideways, narrow ones keep the 16:9 width.
    const span = Math.max(VIEW_SPAN, VIEW_SPAN * (16 / 9) / aspect)
    const direction = new Vector3(
      -Math.sin(CAMERA_YAW) * Math.cos(CAMERA_ELEVATION),
      Math.sin(CAMERA_ELEVATION),
      Math.cos(CAMERA_YAW) * Math.cos(CAMERA_ELEVATION)
    )
    this.camera.aspect = aspect
    this.camera.fov = (2 * Math.atan(span / (2 * CAMERA_DISTANCE)) * 180) / Math.PI
    this.camera.position.copy(ARRAY_AIM).addScaledVector(direction, CAMERA_DISTANCE)
    this.camera.lookAt(ARRAY_AIM)
    this.camera.updateProjectionMatrix()
    this.camera.updateMatrixWorld()
    this.frustum.setFromProjectionMatrix(new Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse))
    this.lastRender = -Infinity
    this.wake()
  }

  private wake(): void {
    if (this.disposed || this.frame || document.hidden) return
    window.clearTimeout(this.idleTimer)
    this.lastFrame = performance.now()
    this.frame = requestAnimationFrame(this.tick)
  }

  private readonly tick = (now: number): void => {
    this.frame = 0
    if (this.disposed) return
    const elapsed = Math.max(0, (now - this.lastFrame) / 1000)
    this.lastFrame = now
    const dt = Math.min(elapsed, 0.05)
    this.clock += dt
    const motion = this.loaded && this.update(dt)
    const idleOnly = !motion && this.idleGain > 0.001
    if (!idleOnly || this.clock - this.lastRender >= IDLE_FRAME_INTERVAL) {
      this.renderer.render(this.scene, this.camera)
      this.lastRender = this.clock
    }
    if (motion || this.idleGain > 0.001 || this.idleEligible()) {
      this.frame = requestAnimationFrame(this.tick)
      return
    }
    // Asleep: come back when breathing should begin.
    if (this.idleFeatureEnabled()) {
      const delay = Math.max(0, IDLE_DELAY - (this.clock - this.lastInteraction))
      this.idleTimer = window.setTimeout(() => this.wake(), delay * 1000 + 30)
    }
  }

  private idleFeatureEnabled(): boolean {
    return this.loaded && !this.reduced && this.focused && this.shelves.length > 0
  }

  private idleEligible(): boolean {
    return this.idleFeatureEnabled() && !this.drag?.active && !this.momentum && !this.pendingPulse &&
      this.pulses.length === 0 && this.clock - this.lastInteraction > IDLE_DELAY
  }

  /** Advance the simulation; returns whether anything besides idle breathing is still moving. */
  private update(dt: number): boolean {
    const reduced = this.reduced
    let moving = false
    this.flushHover()

    if (this.momentum) {
      this.momentum.step(dt)
      const value = this.momentum.value
      this.laneTrack.value = value.lane
      this.rowTrack.value = value.row
      this.followTrack()
      if (this.momentum.phase === 'idle') {
        this.momentum = null
        this.pendingPulse = reduced ? null : { ...this.selected }
      }
      moving = true
      this.lastInteraction = this.clock
    } else if (!this.drag?.active) {
      const rate = reduced ? 35 : 3.7
      damp(this.laneTrack, this.selected.lane, rate, dt)
      damp(this.rowTrack, this.selected.row, rate, dt)
      moving ||= !springSettled(this.laneTrack, this.selected.lane) || !springSettled(this.rowTrack, this.selected.row)
    } else moving = true

    damp(this.shoulder, this.selected.row, reduced ? 35 : 5, dt)
    damp(this.laneFocus, this.selected.lane, reduced ? 35 : 4, dt)
    moving ||= !springSettled(this.shoulder, this.selected.row) || !springSettled(this.laneFocus, this.selected.lane)

    const selectedKey = cellKey(this.selected)
    if (this.shelves.length && !this.lifts.has(selectedKey)) this.lifts.set(selectedKey, { value: 0, velocity: 0 })
    for (const [key, spring] of this.lifts) {
      const target = key === selectedKey && this.shelves.length ? PREVIEW_LIFT : 0
      const rate = reduced ? 35 : target ? (spring.value < PREVIEW_LIFT ? 7.6 : 4.2) : 4.5
      damp(spring, target, rate, dt)
      if (springSettled(spring, target)) {
        spring.value = target
        spring.velocity = 0
        if (target === 0) this.lifts.delete(key)
      } else moving = true
    }

    const hoverKey = this.hoverCell ? cellKey(this.hoverCell) : null
    if (hoverKey && !this.hoverLifts.has(hoverKey)) this.hoverLifts.set(hoverKey, 0)
    for (const [key, value] of this.hoverLifts) {
      const target = key === hoverKey ? HOVER_LIFT : 0
      const next = reduced ? target : value + (target - value) * (1 - Math.exp(-dt * 14))
      if (Math.abs(next - target) < 0.0005) {
        if (target === 0) this.hoverLifts.delete(key)
        else this.hoverLifts.set(key, target)
      } else {
        this.hoverLifts.set(key, next)
        moving = true
      }
    }

    // The new paper causes the wave: it finishes most of its rise before the ripple leaves it.
    if (this.pendingPulse && (this.lifts.get(selectedKey)?.value ?? 0) >= 0.35) {
      this.pulses.push({ ...this.pendingPulse, time: this.clock })
      this.pendingPulse = null
    }
    if (this.pendingPulse) moving = true
    this.pulses = this.pulses.filter((pulse) => this.clock - pulse.time < 3.2)
    if (this.pulses.length) moving = true

    const entry = this.clock - this.entryTime
    if (entry < ENTRY_DURATION + 1.2) moving = true

    const idleTarget = this.idleEligible() ? 1 : 0
    this.idleGain += (idleTarget - this.idleGain) * (1 - Math.exp(-dt * (idleTarget ? 0.8 : 4)))
    if (!idleTarget && this.idleGain < 0.001) this.idleGain = 0

    this.layout(entry)
    return moving
  }

  /** While dragging or coasting, the nearest cell under the track becomes the selection. */
  private followTrack(): void {
    const goal = { lane: Math.round(this.laneTrack.value), row: Math.round(this.rowTrack.value) }
    if (!sameCell(goal, this.selected)) this.select(goal, { pulse: false })
  }

  private field(row: number, lane: number, entry: number): number {
    // Opening scan (reference 22–26.35 s), anchored on the selection like the original's row 12, lane 2.
    const scan = entry < ENTRY_DURATION ? archiveWave(row - this.selected.row + 12, lane - this.selected.lane, entry) : 0
    const shoulderGain = smooth((entry - 1.9) / 1.2)
    let height = scan + settlingWave(row - this.shoulder.value) * columnStrength(lane, this.laneFocus.value) * shoulderGain
    if (this.idleGain > 0) height += idleWave(row, lane, this.clock) * this.idleGain
    if (this.pulses.length) {
      let ripple = 0
      for (const pulse of this.pulses) {
        ripple += selectionWave(Math.hypot(row - pulse.row, (lane - pulse.lane) * 2.2), this.clock - pulse.time)
      }
      height += Math.max(-0.6, Math.min(0.6, ripple))
    }
    return height
  }

  private readonly matrix = new Matrix4()
  private readonly position = new Vector3()
  private readonly rotation = new Quaternion()
  private readonly scale = new Vector3(1, 1, 1)
  private readonly axisX = new Vector3(1, 0, 0)
  private readonly bounds = new Sphere()
  private readonly tint = new Color()

  private layout(entry: number): void {
    const cover = this.surfaces.get('Frosted_Polymer')!
    const index = this.surfaces.get('Index_Inlay')
    const slide = this.reduced ? 0 : -28 * (1 - smooth(entry / 1.1))
    const centerLane = Math.round(this.laneTrack.value)
    // Centre the pool on what is in view, including the entry slide.
    const centerRow = Math.round(this.rowTrack.value - slide / ROW_SPACING)
    const trackX = this.laneTrack.value * COLUMN_SPACING
    const rail = RAIL_OFFSET - this.rowTrack.value * ROW_SPACING
    const fogFar = (this.scene.fog as Fog).far
    let count = 0
    this.strip.visible = false
    for (let lane = centerLane - LANE_RADIUS; lane <= centerLane + LANE_RADIUS; lane++) {
      const shelf = shelfAt(this.shelves, lane)
      const x = lane * COLUMN_SPACING - trackX
      for (let row = centerRow - ROW_RADIUS; row <= centerRow + ROW_RADIUS; row++) {
        const z = row * ROW_SPACING + rail + slide
        // Skip cards outside the view or wholly inside the fog before evaluating their motion.
        this.bounds.center.set(x, BASE_Y + CARD_HEIGHT / 2 + 1, z)
        this.bounds.radius = CARD_RADIUS + 2
        if (!this.frustum.intersectsSphere(this.bounds)) continue
        if (this.bounds.center.distanceTo(this.camera.position) - CARD_RADIUS > fogFar) continue

        const key = `${lane}:${row}`
        const selectedLift = this.lifts.get(key)?.value ?? 0
        const lift = selectedLift + (this.hoverLifts.get(key) ?? 0)
        const height = this.field(row, lane, entry)
        // Cards lean with the slope of the wave until they are lifted clear of it.
        const slope = this.field(row + 0.5, lane, entry) - this.field(row - 0.5, lane, entry)
        this.rotation.setFromAxisAngle(this.axisX, slope * 0.024 * (1 - smooth(lift / PREVIEW_LIFT)))
        this.position.set(x, BASE_Y + height + lift, z)
        this.matrix.compose(this.position, this.rotation, this.scale)
        cover.setMatrixAt(count, this.matrix)

        const selectedAmount = Math.min(1, selectedLift / PREVIEW_LIFT)
        this.tint.copy(this.palette.card).lerp(this.palette.cardSelected, selectedAmount)
        cover.setColorAt(count, this.tint)
        const paper = shelf ? shelf.papers[wrap(row, shelf.papers.length)] : null
        index?.setColorAt(count, this.palette.index.get(indexTone(paper))!)
        if (lane === this.selected.lane && row === this.selected.row && shelf) {
          this.strip.position.copy(this.position)
          this.strip.quaternion.copy(this.rotation)
          ;(this.strip.material as MeshBasicMaterial).opacity = selectedAmount
          this.strip.visible = selectedAmount > 0.01
        }
        const cell = this.drawn[count]
        cell.lane = lane
        cell.row = row
        count++
      }
    }
    this.drawnCount = count
    for (const mesh of this.surfaces.values()) mesh.count = count
    cover.instanceMatrix.needsUpdate = true
    if (cover.instanceColor) cover.instanceColor.needsUpdate = true
    if (index?.instanceColor) index.instanceColor.needsUpdate = true
  }

  private pickCell(clientX: number, clientY: number): ArchiveCell | null {
    const cover = this.surfaces.get('Frosted_Polymer')
    const rect = this.renderer.domElement.getBoundingClientRect()
    if (!cover || !rect.width || !rect.height || !this.drawnCount) return null
    const pointer = new Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(pointer, this.camera)
    cover.computeBoundingSphere()
    const hit = this.raycaster.intersectObject(cover, false)[0]
    return hit?.instanceId === undefined || hit.instanceId >= this.drawnCount ? null : { ...this.drawn[hit.instanceId] }
  }

  private setHover(cell: ArchiveCell | null): void {
    if (cell && this.shelves.length === 0) cell = null
    const next = cell && !sameCell(cell, this.selected) ? cell : null
    this.renderer.domElement.style.cursor = cell ? 'pointer' : 'grab'
    if (next === this.hoverCell || (next && this.hoverCell && sameCell(next, this.hoverCell))) return
    this.hoverCell = next
    this.wake()
  }

  private flushHover(): void {
    const sample = this.pendingHover
    this.pendingHover = null
    if (sample && !this.drag && !this.momentum) this.setHover(this.pickCell(sample.x, sample.y))
  }

  /** Screen-space pixels per lane and per row around the selection, inverted for dragging. */
  private dragInverse(): { lane: Vector2; row: Vector2 } | null {
    const rect = this.renderer.domElement.getBoundingClientRect()
    const project = (x: number, z: number): Vector2 => {
      const point = new Vector3(x, BASE_Y + SHOULDER_PEAK + CARD_HEIGHT / 2, z).project(this.camera)
      return new Vector2((point.x + 1) * rect.width / 2, (1 - point.y) * rect.height / 2)
    }
    const origin = project(0, RAIL_OFFSET)
    const lane = project(COLUMN_SPACING, RAIL_OFFSET).sub(origin)
    const row = project(0, RAIL_OFFSET + ROW_SPACING).sub(origin)
    const determinant = lane.x * row.y - row.x * lane.y
    if (Math.abs(determinant) < lane.length() * row.length() * 0.001) return null
    return {
      lane: new Vector2(row.y / determinant, -row.x / determinant),
      row: new Vector2(-lane.y / determinant, lane.x / determinant)
    }
  }

  private bindInput(canvas: HTMLCanvasElement): void {
    const signal = this.events.signal
    canvas.style.cursor = 'grab'
    canvas.style.touchAction = 'none'
    canvas.addEventListener('pointerdown', (event) => {
      if ((event.pointerType === 'mouse' && event.button !== 0) || this.drag || !this.loaded) return
      this.stopMomentum()
      this.lastInteraction = this.clock
      this.pendingHover = null
      this.setHover(null)
      const start = { lane: this.laneTrack.value, row: this.rowTrack.value }
      this.laneTrack.velocity = this.rowTrack.velocity = 0
      this.drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        start,
        inverse: this.dragInverse(),
        active: false,
        samples: [{ value: start, time: event.timeStamp }]
      }
      canvas.setPointerCapture(event.pointerId)
    }, { signal })
    canvas.addEventListener('pointermove', (event) => {
      const drag = this.drag
      if (!drag) {
        if (event.pointerType === 'mouse' && this.loaded) {
          this.pendingHover = { x: event.clientX, y: event.clientY }
          this.wake()
        }
        return
      }
      if (event.pointerId !== drag.pointerId) return
      const dx = event.clientX - drag.startX
      const dy = event.clientY - drag.startY
      if (!drag.active && Math.hypot(dx, dy) < 8) return
      if (!drag.inverse || this.shelves.length === 0) return
      if (!drag.active) {
        drag.active = true
        canvas.style.cursor = 'grabbing'
      }
      // The plane follows the pointer: moving it by one projected lane shifts the track back one lane.
      const value = {
        lane: drag.start.lane - (dx * drag.inverse.lane.x + dy * drag.inverse.lane.y),
        row: drag.start.row - (dx * drag.inverse.row.x + dy * drag.inverse.row.y)
      }
      this.laneTrack.value = value.lane
      this.rowTrack.value = value.row
      drag.samples.push({ value, time: event.timeStamp })
      drag.samples = drag.samples.filter((sample) => event.timeStamp - sample.time <= 120).slice(-32)
      this.followTrack()
      this.lastInteraction = this.clock
      this.wake()
    }, { signal })
    const release = (event: PointerEvent, cancelled: boolean): void => {
      const drag = this.drag
      if (!drag || event.pointerId !== drag.pointerId) return
      this.drag = null
      canvas.style.cursor = 'grab'
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
      if (drag.active) {
        const first = drag.samples[0]
        const last = drag.samples[drag.samples.length - 1]
        const span = last.time - first.time
        const velocity = cancelled || this.reduced || span < 8 || event.timeStamp - last.time > 80
          ? { lane: 0, row: 0 }
          : { lane: (last.value.lane - first.value.lane) * 1000 / span, row: (last.value.row - first.value.row) * 1000 / span }
        this.momentum = new ArchivePlaneMomentum({ lane: this.laneTrack.value, row: this.rowTrack.value }, velocity)
        this.wake()
        return
      }
      if (cancelled) return
      const cell = this.pickCell(event.clientX, event.clientY)
      if (!cell) return
      if (sameCell(cell, this.selected)) this.activate()
      else this.select(cell)
    }
    canvas.addEventListener('pointerup', (event) => release(event, false), { signal })
    canvas.addEventListener('pointercancel', (event) => release(event, true), { signal })
    canvas.addEventListener('pointerleave', () => {
      this.pendingHover = null
      if (!this.drag) this.setHover(null)
    }, { signal })

    let wheelTotal = { lane: 0, row: 0 }
    let wheelTime = 0
    canvas.addEventListener('wheel', (event) => {
      if (event.ctrlKey || this.drag || !this.loaded) return
      event.preventDefault()
      this.stopMomentum()
      const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? canvas.clientHeight : 1
      const horizontal = event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)
      const axis = horizontal ? 'lane' : 'row'
      const raw = horizontal ? (event.shiftKey ? event.deltaY || event.deltaX : event.deltaX) : event.deltaY
      const delta = Math.max(-300, Math.min(300, raw * unit))
      if (event.timeStamp - wheelTime > 180 || Math.sign(delta) !== Math.sign(wheelTotal[axis])) wheelTotal = { lane: 0, row: 0 }
      wheelTime = event.timeStamp
      wheelTotal[axis] += delta
      const threshold = axis === 'lane' ? 140 : 100
      const steps = Math.min(3, Math.floor(Math.abs(wheelTotal[axis]) / threshold))
      if (!steps) return
      const direction = Math.sign(wheelTotal[axis])
      wheelTotal[axis] -= direction * steps * threshold
      for (let step = 0; step < steps; step++) this.navigate(axis, direction)
    }, { passive: false, signal })

    window.addEventListener('blur', () => {
      this.focused = false
      this.wake()
    }, { signal })
    window.addEventListener('focus', () => {
      this.focused = true
      this.wake()
    }, { signal })
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        cancelAnimationFrame(this.frame)
        this.frame = 0
      } else this.wake()
    }, { signal })
  }
}
