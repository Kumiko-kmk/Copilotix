// Decryption timeline ported from RhineLabUI (MIT, Copyright (c) 2026 LBEILC,
// https://github.com/LBEILC/RhineLabUI): src/decryption.ts, src/glass-reveal.ts and
// src/document-decryption.ts. Times are the original's reference-video seconds; the archive
// plays them faster than the original's interactive rate (1.5) so the decryption stays short.

export const DECRYPTION_START = 34.12
export const DECRYPTION_END = 39.56
const RATE = 2.4
/** Wall-clock length of the archive's decryption (about 2.3 s; the original takes 3.6 s). */
export const DECRYPTION_SECONDS = (DECRYPTION_END - DECRYPTION_START) / RATE

const clamp = (value: number): number => Math.max(0, Math.min(1, value))
const smooth = (value: number): number => {
  const x = clamp(value)
  return x * x * x * (10 + x * (-15 + x * 6))
}

type Knot = readonly [number, number]

/** Monotone cubic Hermite interpolation: the measured easing without overshoot. */
export function sampleCurve(knots: readonly Knot[], time: number): number {
  const first = knots[0]!
  const last = knots[knots.length - 1]!
  if (time <= first[0]) return first[1]
  if (time >= last[0]) return last[1]
  const secant = (i: number): number => (knots[i + 1]![1] - knots[i]![1]) / (knots[i + 1]![0] - knots[i]![0])
  const slope = (i: number): number => {
    if (i === 0 || i === knots.length - 1) return 0
    const a = secant(i - 1)
    const b = secant(i)
    if (a * b <= 0) return 0
    const left = knots[i]![0] - knots[i - 1]![0]
    const right = knots[i + 1]![0] - knots[i]![0]
    const w1 = 2 * right + left
    const w2 = right + 2 * left
    return (w1 + w2) / (w1 / a + w2 / b)
  }
  let i = 0
  while (time > knots[i + 1]![0]) i++
  const span = knots[i + 1]![0] - knots[i]![0]
  const t = (time - knots[i]![0]) / span
  const t2 = t * t
  const t3 = t2 * t
  return (2 * t3 - 3 * t2 + 1) * knots[i]![1] + (t3 - 2 * t2 + t) * span * slope(i) +
    (-2 * t3 + 3 * t2) * knots[i + 1]![1] + (t3 - t2) * span * slope(i + 1)
}

const GROW: readonly Knot[] = [[34.24, 0], [34.4, 0.19], [34.64, 0.57], [34.96, 0.79], [35.28, 0.92], [35.6, 0.973], [36.04, 1]]
const REVEAL: readonly Knot[] = [[38.84, 0], [38.92, 0.28], [39.0, 0.51], [39.16, 0.74], [39.32, 0.94], [39.56, 1]]
const RETRACT: readonly Knot[] = [[37.72, 1], [37.88, 0.72], [38.0, 0.38], [38.12, 0.22], [38.24, 0.14], [38.4, 0.075], [38.64, 0.024], [38.84, 0]]

/**
 * Inspection marks on the card face, in the shell's model space (z is the face). The original's
 * measured endpoints, centred on the archive's page: a bottom-left to top-right diagonal and
 * four corner squares around the window.
 */
export const SCAN_FROM = [-1.75, 0.5] as const
export const SCAN_TO = [1.83, 3.24] as const
export const SCAN_CORNERS = [[-2.02, 3.28], [2.02, 3.28], [-2.02, 0.42], [2.02, 0.42]] as const
export const SCAN_FACE_Z = 0.255

export type DecryptionPhase = 'waiting' | 'joining' | 'connected' | 'retracting' | 'revealing' | 'clear'

export interface DecryptionFrame {
  /** Visible parts of the diagonal, as fractions from SCAN_FROM to SCAN_TO. */
  intervals: Array<[number, number]>
  markers: number
  point: number
  /** Glass clarity: 0 frosted, 1 clear. */
  clarity: number
  phase: DecryptionPhase
}

/** The decryption at `elapsed` wall-clock seconds after it starts. */
export function decryptionFrame(elapsed: number): DecryptionFrame {
  const time = DECRYPTION_START + Math.max(0, elapsed) * RATE
  const grow = sampleCurve(GROW, time)
  const remaining = sampleCurve(RETRACT, time)
  const intervals: Array<[number, number]> = []
  // Two strokes grow in from the ends and meet, hold, then draw back into the centre point.
  if (time >= 34.24 && time < 36.04 && grow > 0) intervals.push([0, grow * 0.5], [1 - grow * 0.5, 1])
  else if (time >= 36.04 && time < 38.84) intervals.push([0.5 - remaining * 0.5, 0.5 + remaining * 0.5])
  return {
    intervals,
    markers: smooth((time - 34.2) / 0.12) * (1 - smooth((time - 37.76) / 0.56)),
    point: smooth((time - 38.58) / 0.2) * (1 - smooth((time - 39.08) / 0.22)),
    clarity: sampleCurve(REVEAL, time),
    phase: time < 34.24 ? 'waiting' : time < 36.04 ? 'joining' : time < 37.72 ? 'connected'
      : time < 38.84 ? 'retracting' : time < DECRYPTION_END ? 'revealing' : 'clear'
  }
}

/** Width of the glass clearing front, as a fraction of the card's height (glass-reveal.ts). */
export const GLASS_FEATHER = 0.12

/** Text redaction: each line's ink slides out to the right, top lines first. */
export const REDACTION_SECONDS = 0.475
const REDACTION_STAGGER = 0.22

/** Progress of one ink bar (0 covering, 1 gone) for overall progress `progress` of `count` bars. */
export function redactionOffset(progress: number, order: number, count: number): number {
  const delay = (order / Math.max(1, count - 1)) * REDACTION_STAGGER
  const t = clamp((progress - delay) / (1 - REDACTION_STAGGER))
  // Brief acceleration, decisive departure, long deceleration; no bounce.
  return t < 0.2 ? 0.4 * (t / 0.2) ** 2 : 1 - 0.6 * ((1 - t) / 0.8) ** (16 / 3)
}
