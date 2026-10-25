import {
  ACESFilmicToneMapping,
  Box3,
  BoxGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  DynamicDrawUsage,
  Fog,
  Frustum,
  Group,
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
  type Texture,
  type IUniform
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
import { cellForPaper, laneStep, paperAt, shelfAt, wrap, type ArchiveCell, type ArchiveShelf } from './archiveShelves'
import {
  GLASS_FEATHER,
  SCAN_CORNERS,
  SCAN_FACE_Z,
  SCAN_FROM,
  SCAN_TO,
  decryptionFrame,
  type DecryptionFrame
} from './archiveDecryption'
import { COLUMN_SPACING, ROW_SPACING, CARD_HEIGHT, CARD_HALF_WIDTH, CARD_BACK, CARD_FRONT, BASE_Y, RAIL_OFFSET, PREVIEW_LIFT, HOVER_LIFT, CAMERA_DISTANCE, VIEW_SPAN, ARRAY_AIM, LANE_RADIUS, ROW_RADIUS, POOL_SIZE, CARD_RADIUS, IDLE_DELAY, TARGET_FRAME_MS, LATE_FRAME_MS, MAX_STEP_SECONDS, MAX_PIXEL_RATIO, MAX_DRAWING_PIXELS, MIN_RESOLUTION_SCALE, DETAIL_PIXEL_RATIO, MAX_DETAIL_PIXELS, ENTRY_DURATION, SHOULDER_RISE, ARRAY_SCREEN_SHIFT, INSPECTION_LIFT, BASE_DIRECTION, DETAIL_DIRECTION, DETAIL_DISTANCE, DETAIL_SPAN, DETAIL_SCREEN, CLOSE_SECONDS, PAGE_HEIGHT, PAGE_MAX_WIDTH, UP, ARRAY_TRAY, DETAIL_TRAY, SHELL_SURFACES, cellKey, sameCell, indexTone, entryScanTime, decodeInlineAsset, type ShellSurface, type ArchivePalette, type PaperArchiveSceneOptions, type DetailPhase, type Pulse } from './archiveSceneConfig'
export { entryScanTime } from './archiveSceneConfig'
export type { ArchivePalette, PaperArchiveSceneOptions, DetailFrame, DetailPhase } from './archiveSceneConfig'

// Scene, model, materials and lighting follow RhineLabUI (MIT, Copyright (c)
// 2026 LBEILC, https://github.com/LBEILC/RhineLabUI): src/scene.ts and
// src/archive-lighting.ts; constants and palette are in ./archiveSceneConfig.
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
  /** Base positions of the drawn cards, for box picking without a triangle raycast. */
  private readonly drawnPositions = new Float32Array(POOL_SIZE * 3)

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
  private momentum: ArchivePlaneMomentum | null = null
  private drag: {
    pointerId: number
    startX: number
    startY: number
    start: PlanePosition
    inverse: { lane: Vector2; row: Vector2 } | null
    active: boolean
    moved: boolean
    samples: Array<{ value: PlanePosition; time: number }>
  } | null = null

  private reduced: boolean
  private loaded = false
  private focused = document.hasFocus()
  private clock = 0
  private entryTime = 0
  private idleGain = 0
  /** Wall-clock ms; the animation clock stops while the scene sleeps, so idle timing cannot use it. */
  private lastInteraction = performance.now()
  private lastVsync = 0
  private lastPresented = 0
  private vsyncDeltas: number[] = []
  private vsyncIndex = 0
  private justWoke = true
  private resolutionScale = 1
  private lateFrames = 0
  private onTimeFrames = 0
  private lastDownscale = -Infinity
  private presentedTimes: number[] = []
  private targetDetail = false
  private detail = 0
  private reveal = 0
  private phase: DetailPhase = 'closed'
  private closing: { elapsed: number; lift: number; detail: number; reveal: number } | null = null
  private pendingSelection: { paperId: string; cell: ArchiveCell; instant: boolean } | null = null
  private pulseGain = 1
  private hero: Group | null = null
  private heroIndex: MeshStandardMaterial | null = null
  private heroTray: MeshStandardMaterial | null = null
  private readonly heroUniforms: Record<'uReveal' | 'uScanColor' | 'uPageSize', IUniform> = {
    uReveal: { value: 0 }, uScanColor: { value: new Color() }, uPageSize: { value: new Vector2(1, 1) }
  }
  private readonly heroPosition = new Vector3()
  private readonly heroRotation = new Quaternion()
  private readerEntryProgress = 0
  private readerEntry: { started: number; finish(): void; cancel(): void } | null = null
  private readonly readerEntryDirection = new Vector3()
  private page: Mesh | null = null
  private pageFront: Mesh | null = null
  private pageTexture: CanvasTexture | null = null
  private cameraKey = ''
  private frame = 0
  private idleTimer = 0
  private disposed = false

  constructor(options: PaperArchiveSceneOptions) {
    this.options = options
    this.reduced = options.reducedMotion
    this.renderer = new WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' })
    this.renderer.outputColorSpace = SRGBColorSpace
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = PCFSoftShadowMap
    this.renderer.toneMapping = ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05
    // The frosted covers blur what they transmit; half resolution is visually identical and saves ~40%.
    this.renderer.transmissionResolutionScale = 0.5
    const canvas = this.renderer.domElement
    canvas.className = 'paper-archive-canvas'
    canvas.setAttribute('aria-hidden', 'true')
    options.container.appendChild(canvas)
    this.inspection = this.createInspection()
    options.container.appendChild(this.inspection.root)

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
    key.shadow.mapSize.set(1024, 1024)
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
      this.createHero()
      this.applyPalette()
      // Compile every program (transmission cover, shadow depth) and draw one warm-up frame before
      // the entry starts; lazily compiling them stalled the first animated frames on the desktop.
      this.layout(0)
      // The hero is compiled with the array, parked below the floor and out of view.
      this.hero!.visible = true
      this.hero!.position.set(0, -200, 0)
      await this.renderer.compileAsync(this.scene, this.camera)
      if (this.disposed) return
      if (this.resolutionDirty) this.flushResolution()
      this.renderer.render(this.scene, this.camera)
      this.hero!.visible = false
      this.loaded = true
      this.renderer.domElement.dataset.archiveState = 'ready'
      this.entryTime = this.reduced ? this.clock - ENTRY_DURATION - 2 : this.clock
      this.lastInteraction = performance.now()
      this.wake()
    } catch (error) {
      if (!this.disposed) this.options.onError?.(error)
    }
  }

  /**
   * The extracted card is drawn by its own meshes (as RhineLabUI's selected model is) so its
   * cover can clear while the array keeps one instanced draw per surface. It shares geometry
   * and, except for the cover and index, materials with the array.
   */
  private createHero(): void {
    const hero = new Group()
    for (const [name, mesh] of this.surfaces) {
      let material = mesh.material as Material
      if (name === 'Frosted_Polymer') material = this.heroCoverMaterial()
      if (name === 'Index_Inlay') material = this.heroIndex = new MeshStandardMaterial({ roughness: 0.5, metalness: 0.05, envMapIntensity: 0.6 })
      // A light tray behind the page, so the cleared card reads as paper rather than the array's dark core.
      if (name === 'Optical_Diffuser') material = this.heroTray = new MeshStandardMaterial({ color: this.arrayTray, roughness: 0.7 })
      if (material !== mesh.material) this.disposables.push(material)
      const part = new Mesh(mesh.geometry, material)
      part.castShadow = name === 'Optical_Diffuser'
      part.receiveShadow = true
      hero.add(part)
    }
    const pageGeometry = new PlaneGeometry(1, 1)
    const pageMaterial = new MeshBasicMaterial({ color: 0xffffff, toneMapped: false })
    this.page = new Mesh(pageGeometry, pageMaterial)
    this.page.position.set(0, CARD_HEIGHT / 2, 0.1)
    this.page.visible = false
    hero.add(this.page)
    // Seen through the half-resolution transmission the inner page stays soft, so a crisp copy in
    // front of the cover is uncovered by the same wipe: frosted page before the line, sharp after.
    const frontMaterial = new MeshBasicMaterial({ color: 0xffffff, toneMapped: false, transparent: true, depthWrite: false })
    const uniforms = this.heroUniforms
    frontMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.uReveal = uniforms.uReveal
      shader.uniforms.uPageSize = uniforms.uPageSize
      shader.vertexShader = 'uniform vec2 uPageSize;\nvarying vec2 vCard;\n' + shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\nvCard = vec2((position.x * uPageSize.x) / 5.0 + 0.5, (${(CARD_HEIGHT / 2).toFixed(3)} + position.y * uPageSize.y) / ${CARD_HEIGHT.toFixed(1)});`
      )
      shader.fragmentShader = 'uniform float uReveal;\nvarying vec2 vCard;\n' + shader.fragmentShader.replace(
        '#include <alphamap_fragment>',
        [
          '#include <alphamap_fragment>',
          `float front = mix(1.12, ${(-0.12 - GLASS_FEATHER).toFixed(3)}, uReveal);`,
          `diffuseColor.a *= smoothstep(front - ${GLASS_FEATHER.toFixed(3)}, front + ${GLASS_FEATHER.toFixed(3)}, vCard.y + 0.22 * (vCard.x - 0.5));`
        ].join('\n')
      )
    }
    frontMaterial.customProgramCacheKey = () => 'paper-archive-page-front'
    this.pageFront = new Mesh(pageGeometry, frontMaterial)
    this.pageFront.position.set(0, CARD_HEIGHT / 2, CARD_FRONT + 0.006)
    this.pageFront.renderOrder = 2
    this.pageFront.visible = false
    hero.add(this.pageFront)
    this.disposables.push(pageGeometry, pageMaterial, frontMaterial)
    hero.visible = false
    this.hero = hero
    this.scene.add(hero)
    for (const mesh of this.surfaces.values()) {
      mesh.geometry.computeBoundingBox()
      this.heroBounds.union(mesh.geometry.boundingBox!)
    }
    this.emitDetailFrame()
  }

  private readonly heroBounds = new Box3()
  private readonly frameCamera = new PerspectiveCamera(3, 1, 1, 200)
  private readonly frameCorner = new Vector3()
  private readonly frameOrigin = new Vector3()
  private frameKey = ''

  /** Project the shell at the final detail framing; the camera aims relative to the card, so its world position does not matter. */
  private emitDetailFrame(): void {
    const { clientWidth: width, clientHeight: height } = this.options.container
    if (!width || !height || this.heroBounds.isEmpty() || !this.options.onDetailFrame) return
    this.pointCamera(this.frameCamera, 1, width, height, this.frameOrigin)
    const { min, max } = this.heroBounds
    let left = Infinity
    let right = -Infinity
    let top = Infinity
    let bottom = -Infinity
    for (let corner = 0; corner < 8; corner++) {
      this.frameCorner.set(corner & 1 ? max.x : min.x, corner & 2 ? max.y : min.y, corner & 4 ? max.z : min.z).project(this.frameCamera)
      const x = (this.frameCorner.x + 1) * width / 2
      const y = (1 - this.frameCorner.y) * height / 2
      left = Math.min(left, x)
      right = Math.max(right, x)
      top = Math.min(top, y)
      bottom = Math.max(bottom, y)
    }
    const frame = { top: Math.round(top), bottom: Math.round(bottom), left: Math.round(left), right: Math.round(right) }
    const key = `${frame.top}:${frame.bottom}:${frame.left}:${frame.right}`
    if (key === this.frameKey) return
    this.frameKey = key
    this.options.onDetailFrame(frame)
  }

  /** The array cover plus a diagonal wipe that clears the frost from the top down. */
  private heroCoverMaterial(): MeshPhysicalMaterial {
    const material = new MeshPhysicalMaterial({
      roughness: 0.28, metalness: 0, transmission: 0.78, ior: 1.46,
      clearcoat: 0.3, clearcoatRoughness: 0.25, envMapIntensity: 0.6
    })
    const uniforms = this.heroUniforms
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uReveal = uniforms.uReveal
      shader.uniforms.uScanColor = uniforms.uScanColor
      shader.vertexShader = 'varying float vPanelHeight;\nvarying float vPanelX;\n' + shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\nvPanelHeight = position.y / ${CARD_HEIGHT.toFixed(1)};\nvPanelX = position.x / 5.0 + 0.5;`
      )
      shader.fragmentShader = [
        'uniform float uReveal;',
        'uniform vec3 uScanColor;',
        'varying float vPanelHeight;',
        'varying float vPanelX;',
        // The feathered front (RhineLabUI glass-reveal.ts) runs slightly diagonally, top first.
        'float paperArchiveEdge() { return vPanelHeight + 0.22 * (vPanelX - 0.5); }',
        `float paperArchiveFront() { return mix(1.12, ${(-0.12 - GLASS_FEATHER).toFixed(3)}, uReveal); }`,
        shader.fragmentShader
      ].join('\n')
        .replace('#include <color_fragment>', [
          '#include <color_fragment>',
          `float clearAmount = smoothstep(paperArchiveFront() - ${GLASS_FEATHER.toFixed(3)}, paperArchiveFront() + ${GLASS_FEATHER.toFixed(3)}, paperArchiveEdge());`,
          'vec3 frostShade = mix(vec3(0.40, 0.30, 0.20), vec3(1.0, 0.98, 0.94), smoothstep(0.1, 1.0, vPanelHeight));',
          'diffuseColor.rgb *= mix(frostShade, vec3(0.8, 0.78, 0.74), clearAmount);'
        ].join('\n'))
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.03, clearAmount);')
        .replace('#include <emissivemap_fragment>', [
          '#include <emissivemap_fragment>',
          'float scanDistance = paperArchiveEdge() - paperArchiveFront();',
          // A sharp line with a soft glow trailing into the frost.
          'float scanLine = (exp(-pow(scanDistance / 0.011, 2.0)) + 0.32 * exp(-pow(scanDistance / 0.07, 2.0))) * step(0.001, uReveal) * step(uReveal, 0.999);',
          'totalEmissiveRadiance += uScanColor * scanLine * 1.6;'
        ].join('\n'))
    }
    material.customProgramCacheKey = () => 'paper-archive-hero'
    return material
  }

  /** Show a page image (the paper's first page) inside the extracted card, or remove it. */
  setDetailPage(page: HTMLCanvasElement | null): void {
    const mesh = this.page
    if (!mesh) return
    this.pageCanvas = page
    this.renderer.domElement.dataset.archiveCover = page ? page.dataset.archiveCover ?? 'first-page' : 'none'
    const material = mesh.material as MeshBasicMaterial
    const front = this.pageFront!
    const frontMaterial = front.material as MeshBasicMaterial
    this.pageTexture?.dispose()
    this.pageTexture = null
    material.map = null
    frontMaterial.map = null
    mesh.visible = false
    front.visible = false
    if (page && page.width > 0 && page.height > 0) {
      const texture = new CanvasTexture(this.pageImage(page))
      texture.colorSpace = SRGBColorSpace
      texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy())
      const aspect = page.width / page.height
      const width = Math.min(PAGE_MAX_WIDTH, PAGE_HEIGHT * aspect)
      mesh.scale.set(width, width / aspect, 1)
      front.scale.copy(mesh.scale)
      ;(this.heroUniforms.uPageSize.value as Vector2).set(width, width / aspect)
      material.map = texture
      frontMaterial.map = texture
      this.pageTexture = texture
      mesh.visible = true
      front.visible = true
    }
    material.needsUpdate = true
    frontMaterial.needsUpdate = true
    this.wake()
  }

  private pageCanvas: HTMLCanvasElement | null = null

  /**
   * The page scaled to the height it is drawn at when the paper is open. A 1600 px page shown at
   * a few hundred device pixels was sampled between mip levels and looked soft; at about 1:1
   * the GPU samples the full-resolution level and the text stays sharp.
   */
  private pageImage(page: HTMLCanvasElement): HTMLCanvasElement {
    const { clientWidth: width, clientHeight: height } = this.options.container
    if (!width || !height) return page
    const span = Math.max(DETAIL_SPAN, DETAIL_SPAN * (16 / 9) / (width / height))
    const aspect = page.width / page.height
    const pageHeight = Math.min(PAGE_HEIGHT, PAGE_MAX_WIDTH / aspect)
    const target = Math.ceil((pageHeight / span) * height * this.detailPixelRatio(width, height))
    if (target >= page.height * 0.9) return page
    const image = document.createElement('canvas')
    image.height = target
    image.width = Math.max(1, Math.round(target * aspect))
    const context = image.getContext('2d', { alpha: false })
    if (!context) return page
    context.imageSmoothingQuality = 'high'
    context.drawImage(page, 0, 0, image.width, image.height)
    return image
  }

  private detailPixelRatio(width: number, height: number): number {
    const native = Math.min(window.devicePixelRatio || 1, DETAIL_PIXEL_RATIO)
    const doubled = native * 2
    return doubled * doubled * width * height <= MAX_DETAIL_PIXELS ? doubled : Math.min(native, Math.sqrt(MAX_DETAIL_PIXELS / (width * height)))
  }

  get detailOpen(): boolean {
    return this.phase !== 'closed'
  }

  get detailReady(): boolean {
    return this.phase === 'open'
  }

  /** A short, additive push of the existing hero, driven by the scene's single frame loop. */
  enterReader(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (this.disposed) return Promise.reject(new DOMException('Scene disposed', 'AbortError'))
    if (this.reduced || !this.detailReady || !this.hero) return Promise.resolve()
    this.cancelReaderEntry()
    return new Promise((resolve, reject) => {
      const cleanup = (): void => signal.removeEventListener('abort', cancel)
      const cancel = (): void => {
        cleanup()
        this.readerEntry = null
        this.readerEntryProgress = 0
        this.wake()
        reject(new DOMException('Reader entry cancelled', 'AbortError'))
      }
      this.readerEntry = { started: performance.now(), cancel, finish: () => {
        cleanup()
        this.readerEntry = null
        resolve()
      } }
      signal.addEventListener('abort', cancel, { once: true })
      this.wake()
    })
  }

  cancelReaderEntry(): void {
    this.readerEntry?.cancel()
    if (this.readerEntryProgress !== 0) {
      this.readerEntryProgress = 0
      this.wake()
    }
  }

  /** Extract the selected paper: lift it clear, turn the camera to it and decrypt its cover. */
  openDetail(): boolean {
    const paper = paperAt(this.shelves, this.selected)
    if (!this.loaded || this.targetDetail || !paper || this.options.canOpenDetail?.(paper) === false) return false
    this.stopMomentum()
    this.hoverCell = null
    this.pendingSelection = null
    this.closing = null
    this.targetDetail = true
    this.lastInteraction = performance.now()
    this.setPhase(this.reveal >= 1 ? 'open' : 'opening')
    this.wake()
    return true
  }

  closeDetail(): void {
    if (!this.targetDetail) return
    this.cancelReaderEntry()
    this.targetDetail = false
    this.lastInteraction = performance.now()
    this.closing = {
      elapsed: 0, lift: this.lifts.get(cellKey(this.selected))?.value ?? 0,
      detail: this.detail, reveal: this.reveal
    }
    this.setPhase('closing')
    if (this.reduced) this.finishClose()
    this.wake()
  }

  private finishClose(): void {
    this.closing = null
    this.detail = this.reveal = 0
    this.heroUniforms.uReveal.value = 0
    this.lifts.set(cellKey(this.selected), { value: PREVIEW_LIFT, velocity: 0 })
    this.setDetailPage(null)
    this.setPhase('closed')
    const pending = this.pendingSelection
    this.pendingSelection = null
    if (!pending) return
    const cell = cellForPaper(this.shelves, pending.paperId, pending.cell)
    if (!cell) return
    if (pending.instant) {
      this.jumpTo(cell)
      this.emitSelection()
    } else this.select(cell)
  }

  private requestSelection(cell: ArchiveCell, instant = false): void {
    this.stopMomentum()
    if (this.detailOpen) {
      const paper = paperAt(this.shelves, cell)
      this.pendingSelection = paper ? { paperId: paper.id, cell, instant } : null
      this.closeDetail()
    } else if (instant) {
      this.jumpTo(cell)
      this.emitSelection()
      this.wake()
    } else this.select(cell)
  }

  private setPhase(phase: DetailPhase): void {
    if (this.phase === phase) return
    const sharp = phase === 'open' || this.phase === 'open'
    this.phase = phase
    if (phase === 'decrypting') {
      this.decryptElapsed = 0
      this.revealAnnounced = false
    }
    if (phase !== 'decrypting') this.decryptFrame = null
    if (sharp) this.applyResolution()
    this.options.onDetailPhase?.(phase)
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
    if (name === 'Optical_Diffuser') return new MeshStandardMaterial({ color: this.arrayTray, roughness: 0.7 })
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
    ;(this.heroUniforms.uScanColor.value as Color).set(palette.accent)
    this.edgeColor.set(palette.edge)
    this.arrayTray.set(palette.tray ?? ARRAY_TRAY)
    const diffuser = this.surfaces.get('Optical_Diffuser')
    if (diffuser) (diffuser.material as MeshStandardMaterial).color.copy(this.arrayTray)
    this.applyPalette()
    this.wake()
  }

  private readonly edgeColor = new Color()
  private readonly arrayTray = new Color(ARRAY_TRAY)

  private applyPalette(): void {
    const edges = this.surfaces.get('Ivory_Edges')
    if (edges) (edges.material as MeshStandardMaterial).color.copy(this.edgeColor)
  }

  setReducedMotion(reduced: boolean): void {
    this.reduced = reduced
    if (reduced && this.closing) this.finishClose()
    this.wake()
  }

  /** Replace the archive contents, keeping the current paper in view when it still exists. */
  setShelves(shelves: ArchiveShelf[]): void {
    const current = paperAt(this.shelves, this.selected)
    this.shelves = shelves
    const keys = new Set(shelves.map((shelf) => shelf.key))
    for (const key of this.memory.keys()) if (!keys.has(key)) this.memory.delete(key)
    const next = current ? cellForPaper(shelves, current.id, this.selected) : null
    if (this.pendingSelection) {
      const cell = cellForPaper(shelves, this.pendingSelection.paperId, this.pendingSelection.cell)
      if (cell) this.pendingSelection.cell = cell
      else this.pendingSelection = null
    }
    if (!next && this.detailOpen) {
      this.pendingSelection = null
      this.targetDetail = false
      this.finishClose()
    }
    if (next && !sameCell(next, this.selected)) {
      const lift = this.lifts.get(cellKey(this.selected))
      this.jumpTo(next)
      if (this.detailOpen && lift) this.lifts.set(cellKey(next), lift)
    }
    this.emitSelection()
    this.wake()
  }

  /** Select a paper by id; returns false when it is not in the archive. */
  focusPaper(paperId: string, options: { instant?: boolean } = {}): boolean {
    const cell = cellForPaper(this.shelves, paperId, this.selected)
    if (!cell) return false
    this.requestSelection(cell, options.instant)
    return true
  }

  navigate(axis: 'lane' | 'row', direction: number): void {
    if (this.drag?.active) return
    const from = this.pendingSelection?.cell ?? this.selected
    const target = axis === 'row'
      ? { lane: from.lane, row: from.row + direction }
      : laneStep(this.shelves, from, direction, this.memory)
    this.requestSelection(target)
  }

  activate(): void {
    const paper = paperAt(this.shelves, this.selected)
    if (paper) this.options.onActivate(paper)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelReaderEntry()
    cancelAnimationFrame(this.frame)
    window.clearTimeout(this.idleTimer)
    this.events.abort()
    this.resizeObserver.disconnect()
    for (const mesh of this.surfaces.values()) mesh.dispose()
    for (const item of this.disposables) item.dispose()
    this.pageTexture?.dispose()
    this.inspection.root.remove()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    this.renderer.domElement.remove()
  }

  private select(cell: ArchiveCell): void {
    this.lastInteraction = performance.now()
    if (sameCell(cell, this.selected)) return
    this.hoverCell = null
    this.selected = { ...cell }
    // As in the original, every selected cell, including each one crossed while dragging,
    // starts its ripple at once; deferring it made a late bump after the plane settled.
    if (!this.reduced) {
      this.pulses.push({ ...cell, time: this.clock })
      if (this.pulses.length > 6) this.pulses.splice(0, this.pulses.length - 6)
    }
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
    // Applied at the next frame: resizing the drawing buffer clears it, and a cleared canvas
    // composited before the next render is the archive's occasional flash.
    this.applyResolution()
    this.cameraKey = ''
    this.updateCamera()
    this.emitDetailFrame()
    if (this.pageCanvas) this.setDetailPage(this.pageCanvas)
    this.wake()
  }

  /**
   * Blend from the array camera to RhineLabUI's detail framing: a more frontal direction,
   * distance 72 and span 5.9, aimed so the lifted card sits left of centre beside the panel.
   */
  private updateCamera(): void {
    const { clientWidth: width, clientHeight: height } = this.options.container
    if (!width || !height) return
    const detail = this.detail
    const key = detail < 1e-4 ? `array:${width}x${height}` : ''
    if (key && key === this.cameraKey) return
    this.cameraKey = key
    const distance = this.pointCamera(this.camera, detail, width, height, this.heroPosition)
    const fog = this.scene.fog as Fog
    fog.near = distance + 5 + (-1 - 5) * detail
    fog.far = distance + 25 + (12 - 25) * detail
    this.frustum.setFromProjectionMatrix(this.frustumMatrix.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse))
  }

  /** Point `camera` for a blend between the array (0) and detail (1) framing; returns its distance. */
  private pointCamera(camera: PerspectiveCamera, detail: number, width: number, height: number, hero: Vector3): number {
    const aspect = width / height
    const baseSpan = VIEW_SPAN + (DETAIL_SPAN - VIEW_SPAN) * detail
    // RhineLabUI's archiveFraming: wide windows extend sideways, narrow ones keep the 16:9 width.
    const span = Math.max(baseSpan, baseSpan * (16 / 9) / aspect)
    const direction = this.cameraDirection.copy(BASE_DIRECTION).lerp(DETAIL_DIRECTION, detail).normalize()
    const distance = CAMERA_DISTANCE + (DETAIL_DISTANCE - CAMERA_DISTANCE) * detail
    const right = this.cameraRight.crossVectors(UP, direction).normalize()
    const up = this.cameraUp.crossVectors(direction, right).normalize()
    const unitsPerPixel = span / height
    // Moving the aim left and up moves the picture right and down.
    const aim = this.cameraAim.copy(ARRAY_AIM)
      .addScaledVector(right, -ARRAY_SCREEN_SHIFT.x * width * unitsPerPixel)
      .addScaledVector(up, ARRAY_SCREEN_SHIFT.y * height * unitsPerPixel)
    if (detail > 0) {
      const detailAim = this.cameraDetailAim.copy(hero)
      detailAim.y += CARD_HEIGHT / 2
      detailAim.addScaledVector(right, (0.5 - DETAIL_SCREEN.x) * width * unitsPerPixel)
      detailAim.addScaledVector(up, (DETAIL_SCREEN.y - 0.5) * height * unitsPerPixel)
      aim.lerp(detailAim, detail)
    }
    camera.aspect = aspect
    camera.fov = (2 * Math.atan(span / (2 * distance)) * 180) / Math.PI
    camera.near = Math.max(1, distance - 45)
    camera.far = distance + 60
    camera.position.copy(aim).addScaledVector(direction, distance)
    camera.lookAt(aim)
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld()
    return distance
  }

  private readonly cameraDirection = new Vector3()
  private readonly cameraAim = new Vector3()
  private readonly cameraRight = new Vector3()
  private readonly cameraUp = new Vector3()
  private readonly cameraDetailAim = new Vector3()
  private readonly frustumMatrix = new Matrix4()

  private decryptElapsed = 0
  private decryptFrame: DecryptionFrame | null = null
  private revealAnnounced = false
  private readonly inspection: { root: SVGSVGElement; lines: SVGPathElement; corners: SVGRectElement[]; point: SVGCircleElement }
  private inspectionShown = false
  private readonly inspectPoint = new Vector3()

  /** RhineLabUI's inspection marks (inspection-overlay.ts): drawn in screen space over the card face. */
  private createInspection(): { root: SVGSVGElement; lines: SVGPathElement; corners: SVGRectElement[]; point: SVGCircleElement } {
    const svg = (name: string): SVGElement => document.createElementNS('http://www.w3.org/2000/svg', name)
    const root = svg('svg') as SVGSVGElement
    root.setAttribute('class', 'paper-archive-inspection')
    root.setAttribute('aria-hidden', 'true')
    const lines = svg('path') as SVGPathElement
    const corners = SCAN_CORNERS.map(() => {
      const corner = svg('rect') as SVGRectElement
      corner.setAttribute('width', '8')
      corner.setAttribute('height', '8')
      return corner
    })
    const point = svg('circle') as SVGCircleElement
    point.setAttribute('r', '2.4')
    root.append(lines, ...corners, point)
    return { root, lines, corners, point }
  }

  private projectFace(x: number, y: number): [number, number] {
    const { clientWidth: width, clientHeight: height } = this.options.container
    this.inspectPoint.set(x, y, SCAN_FACE_Z).applyMatrix4(this.hero!.matrixWorld).project(this.camera)
    return [(this.inspectPoint.x + 1) * width / 2, (1 - this.inspectPoint.y) * height / 2]
  }

  private drawInspection(): void {
    const frame = this.phase === 'decrypting' ? this.decryptFrame : null
    const { root, lines, corners, point } = this.inspection
    if (!frame || !this.hero || !(frame.intervals.length || frame.markers > 0 || frame.point > 0)) {
      if (this.inspectionShown) {
        root.style.opacity = '0'
        this.inspectionShown = false
      }
      return
    }
    const { clientWidth: width, clientHeight: height } = this.options.container
    this.hero.updateMatrixWorld()
    root.setAttribute('viewBox', `0 0 ${width} ${height}`)
    root.style.opacity = '1'
    this.inspectionShown = true
    const along = (t: number): [number, number] => this.projectFace(
      SCAN_FROM[0] + (SCAN_TO[0] - SCAN_FROM[0]) * t,
      SCAN_FROM[1] + (SCAN_TO[1] - SCAN_FROM[1]) * t
    )
    lines.setAttribute('d', frame.intervals.map(([a, b]) => {
      const [ax, ay] = along(a)
      const [bx, by] = along(b)
      return `M${ax.toFixed(1)} ${ay.toFixed(1)}L${bx.toFixed(1)} ${by.toFixed(1)}`
    }).join(''))
    corners.forEach((corner, index) => {
      const cornerPosition = SCAN_CORNERS[index]!
      const [x, y] = this.projectFace(cornerPosition[0]!, cornerPosition[1]!)
      corner.setAttribute('x', (x - 4).toFixed(1))
      corner.setAttribute('y', (y - 4).toFixed(1))
      corner.style.opacity = String(frame.markers)
    })
    const [cx, cy] = along(0.5)
    point.setAttribute('cx', cx.toFixed(1))
    point.setAttribute('cy', cy.toFixed(1))
    point.style.opacity = String(frame.point)
  }

  /** Diagnostics for testers (Ctrl+Shift+F on the archive page). */
  getStats(): { fps: number; pixelRatio: number; resolutionScale: number; drawn: number; triangles: number; gpu: string } {
    const now = performance.now()
    const recent = this.presentedTimes.filter((time) => now - time <= 1000)
    const gl = this.renderer.getContext()
    const debug = gl.getExtension('WEBGL_debug_renderer_info')
    return {
      fps: recent.length,
      pixelRatio: Math.round(this.renderer.getPixelRatio() * 100) / 100,
      resolutionScale: Math.round(this.resolutionScale * 100) / 100,
      drawn: this.drawnCount,
      triangles: this.renderer.info.render.triangles,
      gpu: debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : 'unknown'
    }
  }

  /**
   * Request a drawing-buffer change. Resizing the buffer clears it, so the change is made at the
   * start of a frame that renders right after; changing it between frames (a resize, closing the
   * detail from a key press, or the adaptive step after a render) let a blank canvas reach the
   * screen for a frame, which was the archive's occasional flash.
   */
  private applyResolution(): void {
    this.resolutionDirty = true
    this.wake()
  }

  private resolutionDirty = true

  /** Device pixels are capped by ratio and by total count, then scaled down further if frames run late. */
  private flushResolution(): void {
    this.resolutionDirty = false
    const { clientWidth: width, clientHeight: height } = this.options.container
    if (!width || !height) return
    const open = this.phase === 'open'
    const base = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO, Math.sqrt(MAX_DRAWING_PIXELS / (width * height)))
    const ratio = open ? this.detailPixelRatio(width, height) : Math.max(0.5, base * this.resolutionScale)
    // The open card is static: the glass behind it can be sampled at full resolution too.
    this.renderer.transmissionResolutionScale = open ? 1 : 0.5
    if (ratio !== this.renderer.getPixelRatio()) this.renderer.setPixelRatio(ratio)
    const size = this.renderer.getSize(this.rendererSize)
    if (size.x !== width || size.y !== height) this.renderer.setSize(width, height, false)
  }

  private readonly rendererSize = new Vector2()

  private wake(): void {
    if (this.disposed || this.frame || document.hidden) return
    window.clearTimeout(this.idleTimer)
    this.justWoke = true
    this.frame = requestAnimationFrame(this.tick)
  }

  private readonly tick = (now: number): void => {
    // Keep `frame` non-zero for the whole tick: selections and hover changes made during the
    // update call wake(), which must not start a second loop (that rendered several frames per
    // vsync while dragging or hovering and stalled the GPU).
    this.frame = -1
    if (this.disposed) return
    // Pace to ~60 fps: on 120/144 Hz displays only every second vsync is drawn.
    if (!this.justWoke) {
      const delta = now - this.lastVsync
      if (delta > 1 && delta < 100) {
        this.vsyncDeltas.push(delta)
        if (this.vsyncDeltas.length > 30) this.vsyncDeltas.shift()
      }
    }
    this.lastVsync = now
    const period = this.vsyncDeltas.length ? Math.min(...this.vsyncDeltas) : TARGET_FRAME_MS
    const stride = Math.max(1, Math.round(TARGET_FRAME_MS / period))
    if (!this.justWoke && ++this.vsyncIndex < stride) {
      this.frame = requestAnimationFrame(this.tick)
      return
    }
    this.vsyncIndex = 0
    const continuous = !this.justWoke
    const elapsedMs = continuous ? now - this.lastPresented : TARGET_FRAME_MS
    this.justWoke = false
    this.lastPresented = now
    const dt = Math.min(Math.max(0, elapsedMs) / 1000, MAX_STEP_SECONDS)
    this.clock += dt
    if (this.resolutionDirty) this.flushResolution()
    const motion = this.loaded && this.update(dt)
    // A phase change in update() may ask for a new buffer: apply it before this frame's render.
    if (this.resolutionDirty) this.flushResolution()
    this.drawInspection()
    this.renderer.render(this.scene, this.camera)
    this.presentedTimes.push(now)
    if (this.presentedTimes.length > 240) this.presentedTimes.splice(0, this.presentedTimes.length - 240)
    if (continuous && period < LATE_FRAME_MS - 1) this.adaptResolution(elapsedMs, Math.max(LATE_FRAME_MS, stride * period * 1.5), now)
    if (motion || this.resolutionDirty || this.idleGain > 0.001 || this.idleEligible()) {
      this.frame = requestAnimationFrame(this.tick)
      return
    }
    this.frame = 0
    // Asleep: come back when breathing should begin.
    if (this.idleFeatureEnabled()) {
      const delay = Math.max(0, IDLE_DELAY - (performance.now() - this.lastInteraction) / 1000)
      this.idleTimer = window.setTimeout(() => this.wake(), delay * 1000 + 30)
    }
  }

  /** Lower the drawing resolution while frames keep missing 60 fps; recover slowly once they keep up. */
  private adaptResolution(elapsedMs: number, lateMs: number, now: number): void {
    // Late means at least half a paced interval was missed, not a single stray vsync.
    if (elapsedMs > lateMs) {
      this.lateFrames++
      this.onTimeFrames = 0
    } else {
      this.onTimeFrames++
      this.lateFrames = Math.max(0, this.lateFrames - 0.5)
    }
    if (this.lateFrames >= 6 && this.resolutionScale > MIN_RESOLUTION_SCALE) {
      this.resolutionScale = Math.max(MIN_RESOLUTION_SCALE, this.resolutionScale * 0.85)
      this.lateFrames = 0
      this.lastDownscale = now
      this.applyResolution()
    } else if (this.onTimeFrames > 240 && this.resolutionScale < 1 && now - this.lastDownscale > 8000) {
      this.resolutionScale = Math.min(1, this.resolutionScale * 1.08)
      this.onTimeFrames = 0
      this.applyResolution()
    }
  }

  private idleFeatureEnabled(): boolean {
    return this.loaded && !this.reduced && this.focused && this.shelves.length > 0
  }

  private idleEligible(): boolean {
    return this.idleFeatureEnabled() && !this.detailOpen && this.detail < 0.01 && !this.drag?.active && !this.momentum &&
      this.pulses.length === 0 && (performance.now() - this.lastInteraction) / 1000 > IDLE_DELAY
  }

  /** Advance the simulation; returns whether anything besides idle breathing is still moving. */
  private update(dt: number): boolean {
    const reduced = this.reduced
    let moving = false
    if (this.readerEntry) {
      const progress = reduced ? 1 : Math.min(1, (performance.now() - this.readerEntry.started) / 280)
      this.readerEntryProgress = 1 - (1 - progress) ** 3
      if (progress === 1) this.readerEntry.finish()
      else moving = true
    }
    this.flushHover()

    if (this.momentum) {
      this.momentum.step(dt)
      const value = this.momentum.value
      this.laneTrack.value = value.lane
      this.rowTrack.value = value.row
      this.followTrack()
      if (this.momentum.phase === 'idle') this.momentum = null
      moving = true
      this.lastInteraction = performance.now()
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
      if (key === selectedKey && this.closing) continue
      const target = key === selectedKey && this.shelves.length ? (this.targetDetail ? INSPECTION_LIFT : PREVIEW_LIFT) : 0
      const extracting = key === selectedKey && (this.targetDetail || spring.value > PREVIEW_LIFT + 0.01)
      const rate = reduced ? 35 : extracting ? 5 : target ? 4.2 : 4.5
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

    this.pulses = this.pulses.filter((pulse) => this.clock - pulse.time < 3.2)
    if (this.pulses.length) moving = true
    moving = this.updateDetail(dt, selectedKey) || moving

    const entry = this.clock - this.entryTime
    if (entry < ENTRY_DURATION + 1.2) moving = true

    const idleTarget = this.idleEligible() ? 1 : 0
    this.idleGain += (idleTarget - this.idleGain) * (1 - Math.exp(-dt * (idleTarget ? 0.8 : 4)))
    if (!idleTarget && this.idleGain < 0.001) this.idleGain = 0

    this.layout(entry)
    return moving
  }

  /** Camera progress, decryption and ripple gain for the extracted card; returns whether it is still moving. */
  private updateDetail(dt: number, selectedKey: string): boolean {
    const reduced = this.reduced
    if (this.closing) {
      const closing = this.closing
      closing.elapsed += dt
      const progress = reduced ? 1 : Math.min(1, closing.elapsed / CLOSE_SECONDS)
      const remaining = 1 - smooth(progress)
      this.lifts.set(selectedKey, { value: PREVIEW_LIFT + (closing.lift - PREVIEW_LIFT) * remaining, velocity: 0 })
      this.detail = closing.detail * remaining
      this.reveal = closing.reveal * remaining
      this.heroUniforms.uReveal.value = this.reveal
      if (progress === 1) this.finishClose()
      return true
    }
    const lift = this.lifts.get(selectedKey)?.value ?? 0
    // As in the original, the camera follows the lift: it turns once the card is clear of the array.
    const cameraTarget = this.targetDetail
      ? smooth((lift - 0.8) / 2.4)
      : smooth((lift - PREVIEW_LIFT) / (INSPECTION_LIFT - PREVIEW_LIFT))
    this.detail += (cameraTarget - this.detail) * (reduced ? 1 : 1 - Math.exp(-dt * 3.2))
    if (Math.abs(cameraTarget - this.detail) < 1e-4) this.detail = cameraTarget
    let moving = this.detail !== cameraTarget
    if (this.targetDetail) {
      if (this.phase === 'opening' && this.detail > 0.6 && lift > 3) this.setPhase('decrypting')
      if (this.phase === 'decrypting') {
        // RhineLabUI's sequence: corner marks and a diagonal that grows in from both ends, holds,
        // draws back into a point, then the glass clears from the top.
        this.decryptElapsed += dt
        const frame = reduced ? null : decryptionFrame(this.decryptElapsed)
        this.decryptFrame = frame
        // Re-entry while refrosting continues from the displayed glass.
        this.reveal = frame ? Math.max(this.reveal, frame.clarity) : 1
        if (!this.revealAnnounced && (!frame || frame.clarity > 0)) {
          this.revealAnnounced = true
          this.options.onDecryptReveal?.()
        }
        if (!frame || frame.phase === 'clear') {
          this.reveal = 1
          this.setPhase('open')
        }
        moving = true
      }
    } else if (this.reveal > 0) {
      // Re-frost quickly on the way back, like the original's returning copies.
      this.reveal = reduced ? 0 : this.reveal * Math.exp(-dt * 9)
      if (this.reveal < 0.001) this.reveal = 0
      moving = true
    }
    this.heroUniforms.uReveal.value = this.reveal
    const pulseTarget = this.targetDetail ? 0 : 1
    this.pulseGain += (pulseTarget - this.pulseGain) * (reduced ? 1 : 1 - Math.exp(-dt * 8))
    if (Math.abs(pulseTarget - this.pulseGain) < 1e-3) this.pulseGain = pulseTarget
    else moving = true
    return moving
  }

  /**
   * While dragging or coasting, the cell under the track becomes the selection. Like the
   * original's navigatePlane, every cell along the travelled segment is selected in turn.
   */
  private followTrack(): void {
    const goal = { lane: Math.round(this.laneTrack.value), row: Math.round(this.rowTrack.value) }
    if (sameCell(goal, this.selected)) return
    const from = { ...this.selected }
    const steps = Math.min(64, Math.max(Math.abs(goal.lane - from.lane), Math.abs(goal.row - from.row)))
    for (let step = 1; step <= steps; step++) {
      this.select({
        lane: Math.round(from.lane + ((goal.lane - from.lane) * step) / steps),
        row: Math.round(from.row + ((goal.row - from.row) * step) / steps)
      })
    }
  }

  /** `scan` is the entry time on the original's timeline (see entryScanTime). */
  private field(row: number, lane: number, scan: number): number {
    // Opening scan (reference 22–26.35 s), anchored on the selection like the original's row 12, lane 2.
    const crest = scan < ENTRY_DURATION ? archiveWave(row - this.selected.row + 12, lane - this.selected.lane, scan) : 0
    let height = crest + settlingWave(row - this.shoulder.value) * columnStrength(lane, this.laneFocus.value) * this.shoulderGain
    if (this.idleGain > 0) height += idleWave(row, lane, this.clock) * this.idleGain
    if (this.pulses.length) {
      let ripple = 0
      for (const pulse of this.pulses) {
        ripple += selectionWave(Math.hypot(row - pulse.row, (lane - pulse.lane) * 2.2), this.clock - pulse.time)
      }
      height += Math.max(-0.6, Math.min(0.6, ripple)) * this.pulseGain
    }
    return height
  }

  private shoulderGain = 0
  private readonly matrix = new Matrix4()
  private readonly position = new Vector3()
  private readonly rotation = new Quaternion()
  private readonly scale = new Vector3(1, 1, 1)
  private readonly axisX = new Vector3(1, 0, 0)
  private readonly bounds = new Sphere()
  private readonly tint = new Color()

  /** Whether the selected card is drawn as the separate hero (extracting, open or returning). */
  private heroActive(): boolean {
    if (!this.hero || !this.shelves.length) return false
    const lift = this.lifts.get(cellKey(this.selected))?.value ?? 0
    return this.targetDetail || this.detail > 1e-4 || this.reveal > 0 || lift > PREVIEW_LIFT + 0.02
  }

  /** Pose of one card into `position` / `rotation`; returns its own selection lift. */
  private pose(lane: number, row: number, x: number, z: number, scan: number): number {
    const key = `${lane}:${row}`
    const selectedLift = this.lifts.get(key)?.value ?? 0
    const lift = selectedLift + (this.hoverLifts.get(key) ?? 0)
    const height = this.field(row, lane, scan)
    // Cards lean with the slope of the wave until they are lifted clear of it.
    const slope = this.field(row + 0.5, lane, scan) - this.field(row - 0.5, lane, scan)
    this.rotation.setFromAxisAngle(this.axisX, slope * 0.024 * (1 - smooth(lift / PREVIEW_LIFT)))
    this.position.set(x, BASE_Y + height + lift, z)
    return selectedLift
  }

  private layout(entry: number): void {
    const cover = this.surfaces.get('Frosted_Polymer')!
    const index = this.surfaces.get('Index_Inlay')
    const slide = this.reduced ? 0 : -28 * (1 - smooth(entry / 1.1))
    const scan = entryScanTime(entry)
    this.shoulderGain = smooth((entry - SHOULDER_RISE.start) / SHOULDER_RISE.length)
    const centerLane = Math.round(this.laneTrack.value)
    // Centre the pool on what is in view, including the entry slide.
    const centerRow = Math.round(this.rowTrack.value - slide / ROW_SPACING)
    const trackX = this.laneTrack.value * COLUMN_SPACING
    const rail = RAIL_OFFSET - this.rowTrack.value * ROW_SPACING
    const selected = this.selected
    const selectedShelf = shelfAt(this.shelves, selected.lane)
    const heroActive = this.heroActive()

    // Pose the selected card first: the detail camera aims at it before the array is culled.
    const selectedLift = this.pose(selected.lane, selected.row, selected.lane * COLUMN_SPACING - trackX, selected.row * ROW_SPACING + rail + slide, scan)
    this.heroPosition.copy(this.position)
    this.heroRotation.copy(this.rotation)
    const selectedAmount = Math.min(1, selectedLift / PREVIEW_LIFT)
    this.strip.visible = Boolean(selectedShelf) && selectedAmount > 0.01
    if (this.strip.visible) {
      this.strip.position.copy(this.heroPosition)
      this.strip.quaternion.copy(this.heroRotation)
      ;(this.strip.material as MeshBasicMaterial).opacity = selectedAmount * (1 - this.detail)
    }
    if (this.hero) {
      this.hero.visible = heroActive
      if (heroActive) {
        this.hero.position.copy(this.heroPosition)
        this.hero.quaternion.copy(this.heroRotation)
        this.hero.scale.setScalar(1 + this.readerEntryProgress * 0.04)
        if (this.readerEntryProgress) {
          this.readerEntryDirection.copy(this.camera.position).sub(this.heroPosition).normalize()
          this.hero.position.addScaledVector(this.readerEntryDirection, this.readerEntryProgress * 0.35)
        }
        const paper = selectedShelf ? selectedShelf.papers[wrap(selected.row, selectedShelf.papers.length)] ?? null : null
        this.heroIndex?.color.copy(this.palette.index.get(indexTone(paper))!)
        this.heroTray?.color.copy(this.arrayTray).lerp(DETAIL_TRAY, this.detail)
      }
    }
    this.updateCamera()

    const fogFar = (this.scene.fog as Fog).far
    let count = 0
    for (let lane = centerLane - LANE_RADIUS; lane <= centerLane + LANE_RADIUS; lane++) {
      const shelf = shelfAt(this.shelves, lane)
      const x = lane * COLUMN_SPACING - trackX
      for (let row = centerRow - ROW_RADIUS; row <= centerRow + ROW_RADIUS; row++) {
        if (heroActive && lane === selected.lane && row === selected.row) continue
        const z = row * ROW_SPACING + rail + slide
        // Skip cards outside the view or wholly inside the fog before evaluating their motion.
        this.bounds.center.set(x, BASE_Y + CARD_HEIGHT / 2 + 1, z)
        this.bounds.radius = CARD_RADIUS + 2
        if (!this.frustum.intersectsSphere(this.bounds)) continue
        if (this.bounds.center.distanceTo(this.camera.position) - CARD_RADIUS > fogFar) continue

        const lift = this.pose(lane, row, x, z, scan)
        this.matrix.compose(this.position, this.rotation, this.scale)
        cover.setMatrixAt(count, this.matrix)
        this.tint.copy(this.palette.card).lerp(this.palette.cardSelected, Math.min(1, lift / PREVIEW_LIFT))
        cover.setColorAt(count, this.tint)
        const paper = shelf ? shelf.papers[wrap(row, shelf.papers.length)] ?? null : null
        index?.setColorAt(count, this.palette.index.get(indexTone(paper))!)
        this.recordDrawn(count, lane, row, this.position)
        count++
      }
    }
    this.drawnCount = count
    for (const mesh of this.surfaces.values()) mesh.count = count
    // The hero is not an instance, but it stays pickable after the instances.
    this.pickCount = count
    if (heroActive && count < POOL_SIZE) this.recordDrawn(this.pickCount++, selected.lane, selected.row, this.heroPosition)
    cover.instanceMatrix.needsUpdate = true
    if (cover.instanceColor) cover.instanceColor.needsUpdate = true
    if (index?.instanceColor) index.instanceColor.needsUpdate = true
  }

  private pickCount = 0

  private recordDrawn(slot: number, lane: number, row: number, position: Vector3): void {
    const cell = this.drawn[slot]!
    cell.lane = lane
    cell.row = row
    this.drawnPositions[slot * 3] = position.x
    this.drawnPositions[slot * 3 + 1] = position.y
    this.drawnPositions[slot * 3 + 2] = position.z
  }

  private readonly pickBox = new Box3()
  private readonly pickPoint = new Vector3()

  private pickCell(clientX: number, clientY: number): ArchiveCell | null {
    const rect = this.renderer.domElement.getBoundingClientRect()
    if (!rect.width || !rect.height || !this.pickCount) return null
    const pointer = new Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(pointer, this.camera)
    const ray = this.raycaster.ray
    let nearest = Infinity
    let hit = -1
    // The wave tilt is under 2°, so each card is tested as its upright shell box.
    for (let index = 0; index < this.pickCount; index++) {
      const x = this.drawnPositions[index * 3]!
      const y = this.drawnPositions[index * 3 + 1]!
      const z = this.drawnPositions[index * 3 + 2]!
      this.pickBox.min.set(x - CARD_HALF_WIDTH, y, z + CARD_BACK)
      this.pickBox.max.set(x + CARD_HALF_WIDTH, y + CARD_HEIGHT, z + CARD_FRONT)
      if (!ray.intersectBox(this.pickBox, this.pickPoint)) continue
      const distance = this.pickPoint.distanceToSquared(ray.origin)
      if (distance < nearest) {
        nearest = distance
        hit = index
      }
    }
    const cell = this.drawn[hit]
    return cell ? { ...cell } : null
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
    if (sample && !this.drag && !this.momentum && !this.detailOpen) this.setHover(this.pickCell(sample.x, sample.y))
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
      this.lastInteraction = performance.now()
      this.pendingHover = null
      this.setHover(null)
      const start = { lane: this.laneTrack.value, row: this.rowTrack.value }
      this.laneTrack.velocity = this.rowTrack.velocity = 0
      this.drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        start,
        // The plane does not move while a paper is extracted; the pointer only clicks.
        inverse: this.detailOpen ? null : this.dragInverse(),
        active: false,
        moved: false,
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
      drag.moved = true
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
      this.lastInteraction = performance.now()
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
        const span = first && last ? last.time - first.time : 0
        const velocity = !first || !last || cancelled || this.reduced || span < 8 || event.timeStamp - last.time > 80
          ? { lane: 0, row: 0 }
          : { lane: (last.value.lane - first.value.lane) * 1000 / span, row: (last.value.row - first.value.row) * 1000 / span }
        this.momentum = new ArchivePlaneMomentum({ lane: this.laneTrack.value, row: this.rowTrack.value }, velocity)
        this.wake()
        return
      }
      if (cancelled || drag.moved || Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) >= 8) return
      const cell = this.pickCell(event.clientX, event.clientY)
      if (this.detailOpen) {
        // A deliberate click on the fully revealed paper opens the reader; elsewhere puts it back.
        if (cell && sameCell(cell, this.selected)) {
          if (this.phase === 'closing') this.openDetail()
          else if (this.detailReady) this.activate()
        }
        else this.closeDetail()
        return
      }
      if (!cell) return
      if (sameCell(cell, this.selected)) this.openDetail()
      else this.select(cell)
    }
    canvas.addEventListener('pointerup', (event) => release(event, false), { signal })
    canvas.addEventListener('pointercancel', (event) => release(event, true), { signal })
    canvas.addEventListener('lostpointercapture', (event) => release(event, true), { signal })
    canvas.addEventListener('pointerleave', () => {
      this.pendingHover = null
      if (!this.drag) this.setHover(null)
    }, { signal })

    let wheelTotal = { lane: 0, row: 0 }
    let wheelTime = 0
    canvas.addEventListener('wheel', (event) => {
      if (event.ctrlKey || this.drag || !this.loaded) return
      event.preventDefault()
      if (this.detailOpen) return
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
