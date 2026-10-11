// The 360° viewer for an extracted file, ported from RhineLabUI (MIT, Copyright (c) 2026 LBEILC,
// https://github.com/LBEILC/RhineLabUI): src/model-viewer.ts. Its own renderer, camera and
// OrbitControls; part groups move along the card's depth by `depth × spread` while the spread eases
// to 0 (assembled) or 1 (apart). Copilotix takes the file apart by the paper's structure: the shell
// in front and behind, one sheet per section in between.
import {
  ACESFilmicToneMapping,
  CanvasTexture,
  Color,
  DirectionalLight,
  DoubleSide,
  Fog,
  Group,
  HemisphereLight,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Scene,
  SRGBColorSpace,
  TOUCH,
  Vector3,
  WebGLRenderer,
  type BufferGeometry,
  type Material,
  type Texture
} from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import archiveShellUrl from './assets/archive-shell.glb?inline'
import { damp, type Spring } from './archiveMotion'
import { ViewerCameraMotion } from './viewerCamera'

export interface ViewerPart {
  id: string
  label: string
  en: string
  /** Offset along the card's depth when apart. */
  depth: number
  kind: 'shell' | 'section'
}

/** A section sheet: its list entry and the texture shown between the shell parts. */
export interface ViewerSection { label: string; sheet: HTMLCanvasElement }

export type ViewerState = 'assembled' | 'apart' | 'moving'

const CARD_HEIGHT = 3.7
/** The card's window, where the sheets sit (model units). */
const SHEET = { width: 3.9, height: 2.76 }
/** Sections are spread evenly between the cover and the carrier. */
const SECTION_RANGE = { front: 1.05, back: -1.25 }
const SURFACE_PART: Record<string, string> = {
  Titanium_Fasteners: 'fasteners', Frosted_Polymer: 'cover', Index_Inlay: 'cover', Optical_Diffuser: 'carrier', Ivory_Edges: 'carrier'
}

/** The parts in front-to-back order: fasteners, cover, one per section, carrier. */
export function viewerParts(sections: readonly Pick<ViewerSection, 'label'>[]): ViewerPart[] {
  const count = sections.length
  const step = count > 1 ? (SECTION_RANGE.front - SECTION_RANGE.back) / (count - 1) : 0
  return [
    { id: 'fasteners', label: '紧固件', en: 'FASTENERS', depth: 2.75, kind: 'shell' },
    { id: 'cover', label: '透明盖板', en: 'OPTICAL COVER', depth: 1.85, kind: 'shell' },
    ...sections.map((section, index): ViewerPart => ({
      id: `section-${index}`, label: section.label, en: `SECTION ${String(index + 1).padStart(2, '0')}`,
      depth: count > 1 ? SECTION_RANGE.front - step * index : -0.1, kind: 'section'
    })),
    { id: 'carrier', label: '背板与框架', en: 'CARRIER', depth: -2.05, kind: 'shell' }
  ]
}

function decodeInlineAsset(url: string): ArrayBuffer {
  const binary = atob(url.slice(url.indexOf(',') + 1))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes.buffer
}

export class ArchiveViewer {
  readonly parts: ViewerPart[]
  private readonly renderer: WebGLRenderer
  private readonly scene = new Scene()
  private readonly camera = new PerspectiveCamera(34, 16 / 9, 0.3, 120)
  private readonly controlCamera = this.camera.clone()
  private readonly cameraMotion = new ViewerCameraMotion(this.camera)
  private readonly controls: OrbitControls
  private readonly initialCamera = new Vector3(7.2, 3.8, 12)
  private readonly model = new Group()
  private readonly groups = new Map<string, Group>()
  private readonly sheets = new Map<string, { material: MeshBasicMaterial; lift: Spring; fade: Spring }>()
  private readonly disposables: Array<BufferGeometry | Material | Texture> = []
  private readonly resizeObserver: ResizeObserver
  private spread: Spring = { value: 0, velocity: 0 }
  private targetSpread = 0
  private focused: string | null = null
  private state: ViewerState = 'assembled'
  private frame = 0
  private lastTime = 0
  private disposed = false

  constructor(
    private readonly host: HTMLElement,
    private readonly sections: readonly ViewerSection[],
    private readonly options: { background: string; reduced: boolean; onState?(state: ViewerState): void }
  ) {
    this.parts = viewerParts(sections)
    this.renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    this.renderer.outputColorSpace = SRGBColorSpace
    this.renderer.toneMapping = ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05
    const canvas = this.renderer.domElement
    canvas.className = 'paper-archive-viewer-canvas'
    canvas.tabIndex = 0
    canvas.setAttribute('aria-label', '档案三维模型：拖动旋转，方向键平移，滚轮或加减键缩放，Home 复位')
    host.appendChild(canvas)
    this.scene.background = new Color(options.background)
    this.scene.fog = new Fog(options.background, 13.5, 26.5)
    this.light()
    this.camera.position.copy(this.initialCamera)
    this.controlCamera.copy(this.camera)
    this.controls = new OrbitControls(this.controlCamera, canvas)
    this.controls.enableDamping = false
    this.controls.rotateSpeed = 0.65
    this.controls.zoomSpeed = 0.7
    this.controls.panSpeed = 0.7
    this.controls.minDistance = 5
    this.controls.maxDistance = 28
    this.controls.maxTargetRadius = 5
    this.controls.screenSpacePanning = true
    this.controls.touches.ONE = TOUCH.ROTATE
    this.controls.touches.TWO = TOUCH.DOLLY_PAN
    this.controls.enabled = false
    this.controls.update()
    this.cameraMotion.snap(this.controlCamera, this.controls.target)
    this.controls.addEventListener('start', () => this.interruptReset())
    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(host)
    this.resize()
  }

  /** Studio light as in the archive (RhineLabUI's archive-lighting.ts), recreated for this renderer. */
  private light(): void {
    const pmrem = new PMREMGenerator(this.renderer)
    const room = new RoomEnvironment()
    const environment = pmrem.fromScene(room, 0.04).texture
    room.dispose()
    pmrem.dispose()
    this.disposables.push(environment)
    this.scene.environment = environment
    this.scene.environmentIntensity = 0.48
    this.scene.add(new HemisphereLight('#fffaf5', '#b4a18c', 0.65))
    const key = new DirectionalLight('#fff7ed', 1.4)
    key.position.set(-6, 14, 5)
    const fill = new DirectionalLight('#ffffff', 0.6)
    fill.position.set(7, 8, 10)
    this.scene.add(key, fill)
  }

  async load(): Promise<void> {
    const gltf = await new GLTFLoader().parseAsync(decodeInlineAsset(archiveShellUrl), '')
    if (this.disposed) return
    for (const part of this.parts) {
      const group = new Group()
      group.name = part.id
      this.groups.set(part.id, group)
      this.model.add(group)
    }
    gltf.scene.updateMatrixWorld(true)
    gltf.scene.traverse((object) => {
      if (!(object instanceof Mesh)) return
      const source = object.material as MeshStandardMaterial
      const name = source.name.replace(/\.\d+$/, '')
      const group = this.groups.get(SURFACE_PART[name] ?? '')
      if (!group) return
      const geometry = (object.geometry as BufferGeometry).clone().applyMatrix4(object.matrixWorld)
      const material = this.material(name, source)
      this.disposables.push(geometry, material)
      group.add(new Mesh(geometry, material))
    })
    gltf.scene.traverse((object) => {
      if (!(object instanceof Mesh)) return
      object.geometry.dispose()
      ;(object.material as Material).dispose()
    })
    const plane = new PlaneGeometry(SHEET.width, SHEET.height)
    this.disposables.push(plane)
    this.sections.forEach((section, index) => {
      const texture = new CanvasTexture(section.sheet)
      texture.colorSpace = SRGBColorSpace
      texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy())
      const material = new MeshBasicMaterial({ map: texture, toneMapped: false, transparent: true, side: DoubleSide })
      const sheet = new Mesh(plane, material)
      // Assembled, the sheets stack inside the card a hair apart instead of fighting for one plane.
      sheet.position.set(0, CARD_HEIGHT / 2, 0.06 - index * 0.012)
      this.groups.get(`section-${index}`)!.add(sheet)
      this.sheets.set(`section-${index}`, { material, lift: { value: 0, velocity: 0 }, fade: { value: 1, velocity: 0 } })
      this.disposables.push(texture, material)
    })
    // The assembled card is centred on the origin, as in the original.
    this.model.position.set(0, -CARD_HEIGHT / 2, 0)
    this.scene.add(this.model)
    this.controls.enabled = true
    this.lastTime = 0
    this.frame = requestAnimationFrame(this.tick)
  }

  /**
   * The cassette's own materials, with the cover clear as in the original's 清晰 mode. A thin
   * transparent glass (not transmission) so the sections behind it stay sharp and readable.
   */
  private material(name: string, source: MeshStandardMaterial): Material {
    if (name === 'Frosted_Polymer') {
      return new MeshPhysicalMaterial({
        color: '#ffffff', roughness: 0.08, metalness: 0, transparent: true, opacity: 0.16, depthWrite: false,
        clearcoat: 0.6, clearcoatRoughness: 0.15, envMapIntensity: 0.9
      })
    }
    if (name === 'Optical_Diffuser') return new MeshStandardMaterial({ color: '#efe7da', roughness: 0.7 })
    const material = source.clone()
    material.envMapIntensity = 0.6
    return material
  }

  setExploded(apart: boolean): void {
    this.targetSpread = apart ? 1 : 0
    if (this.options.reduced) this.spread = { value: this.targetSpread, velocity: 0 }
    this.setState(this.spread.value === this.targetSpread ? (apart ? 'apart' : 'assembled') : 'moving')
  }

  /** Bring one section forward and dim the others; null shows every part evenly. */
  focus(id: string | null): void {
    this.focused = id && this.sheets.has(id) ? id : null
  }

  resetView(animated = true): void {
    this.controls.enabled = false
    this.controls.update()
    this.controls.target.set(0, 0, 0)
    this.controlCamera.position.copy(this.initialCamera)
    this.controls.update()
    if (animated && !this.options.reduced) this.cameraMotion.reset()
    else this.cameraMotion.snap(this.controlCamera, this.controls.target)
    this.controls.enabled = true
  }

  /** Keyboard zoom, as the original's +/− (the wheel goes through OrbitControls). */
  zoom(zoomIn: boolean): void {
    this.interruptReset()
    const distance = this.controlCamera.position.distanceTo(this.controls.target)
    const next = MathUtils.clamp(distance * (zoomIn ? 1 / 1.12 : 1.12), this.controls.minDistance, this.controls.maxDistance)
    this.controlCamera.position.sub(this.controls.target).multiplyScalar(next / distance).add(this.controls.target)
    this.controls.update()
  }

  /** Keyboard panning, as the original's arrow keys; clamps the focus before moving the camera. */
  pan(x: number, y: number): void {
    this.interruptReset()
    const right = new Vector3().setFromMatrixColumn(this.camera.matrix, 0)
    const up = new Vector3().setFromMatrixColumn(this.camera.matrix, 1)
    const step = this.controlCamera.position.distanceTo(this.controls.target) * 0.025
    const previous = this.controls.target.clone()
    this.controls.target.addScaledVector(right, x * step).addScaledVector(up, y * step)
    this.controls.target.clampLength(0, this.controls.maxTargetRadius)
    this.controlCamera.position.add(this.controls.target.clone().sub(previous))
    this.controls.update()
  }

  focusCanvas(): void {
    this.renderer.domElement.focus({ preventScroll: true })
  }

  private interruptReset(): void {
    if (!this.cameraMotion.resetting) return
    this.cameraMotion.interruptReset(this.controlCamera, this.controls.target)
    this.controls.update()
  }

  private setState(state: ViewerState): void {
    if (state === this.state) return
    this.state = state
    this.options.onState?.(state)
  }

  private readonly tick = (time: number): void => {
    if (this.disposed) return
    this.frame = requestAnimationFrame(this.tick)
    if (document.hidden) return
    const dt = Math.min(this.lastTime ? (time - this.lastTime) / 1000 : 1 / 60, 0.05)
    this.lastTime = time
    damp(this.spread, this.targetSpread, 5.5, dt)
    if (Math.abs(this.spread.value - this.targetSpread) < 0.0001 && Math.abs(this.spread.velocity) < 0.001) {
      this.spread = { value: this.targetSpread, velocity: 0 }
      this.setState(this.targetSpread ? 'apart' : 'assembled')
    }
    for (const part of this.parts) this.groups.get(part.id)!.position.z = part.depth * this.spread.value
    // A chosen section rises a little and the rest step back.
    for (const [id, sheet] of this.sheets) {
      const chosen = this.focused === id
      damp(sheet.lift, chosen ? 0.22 * this.spread.value : 0, 9, dt)
      damp(sheet.fade, this.focused && !chosen ? 0.18 : 1, 9, dt)
      this.groups.get(id)!.position.y = sheet.lift.value
      sheet.material.opacity = sheet.fade.value
    }
    this.controls.update()
    this.cameraMotion.update(this.controlCamera, this.controls.target, dt, this.options.reduced)
    // The original's gentle haze, kept off the object as the user zooms.
    const fog = this.scene.fog as Fog
    const distance = this.camera.position.length()
    fog.near = Math.max(0, distance - 1)
    fog.far = distance + 12
    this.renderer.render(this.scene, this.camera)
  }

  private resize(): void {
    const width = this.host.clientWidth
    const height = this.host.clientHeight
    if (!width || !height) return
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.controlCamera.aspect = this.camera.aspect
    this.controlCamera.updateProjectionMatrix()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    cancelAnimationFrame(this.frame)
    this.resizeObserver.disconnect()
    this.controls.dispose()
    for (const item of this.disposables) item.dispose()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    this.renderer.domElement.remove()
  }
}
