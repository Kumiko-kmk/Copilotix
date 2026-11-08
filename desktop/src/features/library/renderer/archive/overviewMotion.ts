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
/** Spring rate for the climb and the descent: settles in about 1.1 s. */
export const OVERVIEW_RATE = 4
/** Band drift in world units per second at full overview. */
export const OVERVIEW_DRIFT_SPEED = 0.55

export interface LaneDrift {
  /** Whole rows the band has moved, so each card keeps its paper as it slides. */
  rows: number
  /** Remaining offset along the band, in [0, ROW_SPACING). */
  offset: number
}

export const NO_DRIFT: LaneDrift = { rows: 0, offset: 0 }

/**
 * Neighbouring bands drift in opposite directions at the same constant speed.
 *
 * A band repeats its papers every `period` rows, so the drift is first wrapped into the
 * equivalent shift nearest zero (at most half a cycle), then scaled by `weight`, the overview
 * amount. On the way back down the shift therefore unwinds to exactly zero and the array is
 * left aligned with its selection; without it the band kept the drift and the selected card no
 * longer matched the rows around it.
 */
export function laneDrift(lane: number, time: number, period: number, weight: number): LaneDrift {
  if (weight <= 0 || time <= 0) return NO_DRIFT
  const direction = lane % 2 === 0 ? 1 : -1
  let distance = direction * OVERVIEW_DRIFT_SPEED * time
  if (period > 0) {
    const cycle = period * ROW_SPACING
    distance -= Math.round(distance / cycle) * cycle
  }
  distance *= weight
  const rows = Math.floor(distance / ROW_SPACING)
  return { rows, offset: distance - rows * ROW_SPACING }
}
