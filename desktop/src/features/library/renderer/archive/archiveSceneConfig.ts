import { Color, Vector3 } from 'three'
import { smooth } from './archiveMotion'
import { type ArchiveCell, type ArchivePaper } from './archiveShelves'

/** Layout, camera, frame-budget and palette constants of the archive scene (see ./PaperArchiveScene). */

// Scene, model, materials and lighting follow RhineLabUI (MIT, Copyright (c)
// 2026 LBEILC, https://github.com/LBEILC/RhineLabUI): src/scene.ts and
// src/archive-lighting.ts. The cassette shell is extracted from its
// archive-cassette.glb. Lanes are 5.2 apart, rows 0.62 apart, and a 59° / 19°
// camera at a long distance with a narrow field of view frames the array.
export const COLUMN_SPACING = 5.2

export const ROW_SPACING = 0.62
export const CARD_HEIGHT = 3.7
export const CARD_HALF_WIDTH = 2.5
export const CARD_BACK = -0.13
export const CARD_FRONT = 0.21
export const BASE_Y = -4.6
export const RAIL_OFFSET = -2.17
export const PREVIEW_LIFT = 0.4
export const HOVER_LIFT = 0.28
export const CAMERA_DISTANCE = 140
export const CAMERA_YAW = (59 * Math.PI) / 180
export const CAMERA_ELEVATION = (19 * Math.PI) / 180
export const VIEW_SPAN = 7.33
export const ARRAY_AIM = new Vector3(-1.091, -0.045, 0.481)
export const LANE_RADIUS = 4
export const ROW_RADIUS = 30
export const POOL_SIZE = (LANE_RADIUS * 2 + 1) * (ROW_RADIUS * 2 + 1)
export const CARD_RADIUS = 3.4

export const IDLE_DELAY = 2.5
// Frame budget (measured on the reference machine at 1920×1080: 18.5 ms per frame at DPR 1.5
// with full-resolution transmission, ~9 ms with the limits below).

export const TARGET_FRAME_MS = 1000 / 60
export const LATE_FRAME_MS = 23

/**
 * Longest animation step for one rendered frame. Motion keeps wall-clock pace down to 4 fps; a
 * smaller cap stretched every transition on software renderers (a 50 ms cap at 1 fps played
 * 0.75 s of settling over 15 multi-second frames and held input behind them). The integrators are
 * closed-form, so larger steps stay stable; a hidden window stops the loop instead.
 */
export const MAX_STEP_SECONDS = 0.25

export const MAX_PIXEL_RATIO = 1.25
export const MAX_DRAWING_PIXELS = 3.3e6

export const MIN_RESOLUTION_SCALE = 0.55
// Once a paper is open nothing moves and the scene only redraws on change, so it is drawn at
// twice the display's density when that fits (the browser averages each 2×2 block: smoother
// edges and text) and at the display's own density otherwise. Browse limits return on close.

export const DETAIL_PIXEL_RATIO = 2
export const MAX_DETAIL_PIXELS = 8.3e6

export const ENTRY_DURATION = 4.35
// The original holds the plane almost flat for ~1.3 s between the outgoing scan crest and its
// return (its entry was timed to music). The archive runs that stretch about five times faster,
// so the cards rise into the wave as soon as they finish sliding in.

export const ENTRY_GAP = { start: 0.95, length: 0.5, skipped: 1.25 }

// The resting shoulder rises over real time as the slide ends, full when the returning crest crosses it.
export const SHOULDER_RISE = { start: 0.95, length: 0.9 }
// Browse framing: the selected card sits a little left of and below the original's aim, which
// balances it against the panel (fractions of the view).

export const ARRAY_SCREEN_SHIFT = { x: -0.04, y: 0.1 }

// Extraction and detail framing from RhineLabUI (INSPECTION_LIFT, archiveFraming detail values).
export const INSPECTION_LIFT = 4.05

export const BASE_DIRECTION = new Vector3(
  -Math.sin(CAMERA_YAW) * Math.cos(CAMERA_ELEVATION),
  Math.sin(CAMERA_ELEVATION),
  Math.cos(CAMERA_YAW) * Math.cos(CAMERA_ELEVATION)
)

export const DETAIL_DIRECTION = new Vector3(-0.277, 0.238, 0.931).normalize()
export const DETAIL_DISTANCE = 72
export const DETAIL_SPAN = 5.9
export const DETAIL_SCREEN = { x: 550 / 1920, y: 560 / 1080 }
export const CLOSE_SECONDS = 0.32
export const PAGE_HEIGHT = 3.15
export const PAGE_MAX_WIDTH = 4.5

export const UP = new Vector3(0, 1, 0)
// The array's dark inner diffuser and the light tray of the extracted card, blended with the camera.
/** The calibrated diffuser colour; a colour theme may replace it (ArchivePalette.tray). */

export const ARRAY_TRAY = '#806447'
export const DETAIL_TRAY = new Color('#efe7da')
export const SHELL_SURFACES = ['Frosted_Polymer', 'Ivory_Edges', 'Index_Inlay', 'Titanium_Fasteners', 'Optical_Diffuser'] as const
export type ShellSurface = typeof SHELL_SURFACES[number]

export interface ArchivePalette {
  background: string
  floor: string
  card: string
  cardSelected: string
  edge: string
  /** Diffuser seen through the frosted cassettes. */
  tray?: string
  accent: string
  index: Record<'done' | 'active' | 'partial' | 'failed' | 'empty', string>
}

export interface PaperArchiveSceneOptions {
  container: HTMLElement
  palette: ArchivePalette
  reducedMotion: boolean
  /** The selected cell changed (drag, wheel, click or keyboard). */
  onSelect(cell: ArchiveCell, paper: ArchivePaper | null): void
  /** The extracted paper was clicked: open it in the reader. */
  onActivate(paper: ArchivePaper): void
  /** All routes into detail (including card pointer input) share this guard. */
  canOpenDetail?(paper: ArchivePaper): boolean
  /** A completed cover is attached before extraction begins; cold requests stay in browse. */
  getDetailCover?(paper: ArchivePaper): DetailCoverHandle | null
  prepareDetailCover?(paper: ArchivePaper, signal: AbortSignal): Promise<DetailCoverHandle>
  onDetailCoverError?(message: string): void
  /** The model could not be prepared; the page shows a fallback. */
  onError?(error: unknown): void
  /** Extraction state of the selected paper, for the detail panel. */
  onDetailPhase?(phase: DetailPhase): void
  /** Where the fully extracted card will sit, in container pixels, so the panel can match its height. */
  onDetailFrame?(frame: DetailFrame): void
  /** The glass has started to clear: the panel's text redaction follows it. */
  onDecryptReveal?(): void
}

export interface DetailFrame {
  top: number
  bottom: number
  left: number
  right: number
}

/** closed → opening (lifting, camera turning) → decrypting (cover clearing) → open. */
export type DetailPhase = 'closed' | 'opening' | 'decrypting' | 'open' | 'closing'

export interface DetailCoverHandle {
  key: string
  canvas: HTMLCanvasElement
  kind: 'spread' | 'single'
  release(): void
}

export type Pulse = { row: number; lane: number; time: number }
export const cellKey = (cell: ArchiveCell): string => `${cell.lane}:${cell.row}`
export const sameCell = (a: ArchiveCell, b: ArchiveCell): boolean => a.lane === b.lane && a.row === b.row

export function indexTone(paper: ArchivePaper | null): keyof ArchivePalette['index'] {
  if (!paper) return 'empty'
  const status = paper.workflow.status
  if (status === 'completed') return 'done'
  if (status === 'failed') return 'failed'
  if (status === 'partial') return 'partial'
  return 'active'
}

/** Scan time for an entry time: monotonic, identical outside the shortened gap. */
export function entryScanTime(entry: number): number {
  return entry + ENTRY_GAP.skipped * smooth((entry - ENTRY_GAP.start) / ENTRY_GAP.length)
}

export function decodeInlineAsset(url: string): ArrayBuffer {
  const binary = atob(url.slice(url.indexOf(',') + 1))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes.buffer
}
