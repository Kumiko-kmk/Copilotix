import { Vector3 } from 'three'
import { BASE_Y, CARD_HEIGHT, RAIL_OFFSET, ROW_SPACING } from './archiveSceneConfig'

/**
 * The whole-library overview: the camera climbs to look straight down on the array and rolls so
 * each category column becomes a band running across the screen, tilted down to the right.
 * Neighbouring bands then slide past each other. The drift is decoration only; it does not
 * move papers between rows or change the selection.
 */

/** Straight down; `OVERVIEW_UP` keeps `lookAt` defined and sets the bands' tilt. */
export const OVERVIEW_DIRECTION = new Vector3(0, 1, 0)
/** Bands (columns, along world z) tilt this far below horizontal, going right. */
export const OVERVIEW_TILT = (18 * Math.PI) / 180
/** Screen-up in world space: across the bands, rotated so +z points right and down. */
export const OVERVIEW_UP = new Vector3(Math.cos(OVERVIEW_TILT), 0, -Math.sin(OVERVIEW_TILT))
export const OVERVIEW_DISTANCE = 230
export const OVERVIEW_SPAN = 34
export const OVERVIEW_AIM = new Vector3(0, BASE_Y + CARD_HEIGHT, RAIL_OFFSET)
/** Spring rate for the climb and the descent: fast, settling in about 0.6 s. */
export const OVERVIEW_RATE = 7
/** Band drift in world units per second at full overview. */
export const OVERVIEW_DRIFT_SPEED = 0.55

export interface LaneDrift {
  /** Whole rows the band has moved, so each card keeps its paper as it slides. */
  rows: number
  /** Remaining offset along the band, in [0, ROW_SPACING). */
  offset: number
}

export const NO_DRIFT: LaneDrift = { rows: 0, offset: 0 }

/** Neighbouring bands drift in opposite directions at the same constant speed. */
export function laneDrift(lane: number, time: number): LaneDrift {
  const direction = lane % 2 === 0 ? 1 : -1
  const distance = direction * OVERVIEW_DRIFT_SPEED * time
  const rows = Math.floor(distance / ROW_SPACING)
  return { rows, offset: distance - rows * ROW_SPACING }
}
