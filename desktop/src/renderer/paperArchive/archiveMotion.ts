// Motion curves ported from RhineLabUI (MIT, Copyright (c) 2026 LBEILC,
// https://github.com/LBEILC/RhineLabUI): src/motion.ts and src/archive-drag.ts.
// Only the interactive browsing curves are kept; the cinematic timeline,
// music and relay game are not part of the paper archive.

export const smooth = (t: number): number => {
  t = Math.max(0, Math.min(1, t))
  return t * t * t * (10 + t * (-15 + 6 * t))
}

const bell = (x: number, width: number): number => Math.exp(-0.5 * (x / width) ** 2)

/** Entry scan: a crest travels across the array and returns. Zero outside 0 < t < 4.35. */
export function archiveWave(row: number, lane: number, t: number): number {
  if (t <= 0 || t >= 4.35) return 0
  const phase = row + lane * 0.65
  const enter = smooth(t / 0.32)
  const first = 3 + t * 19
  const returning = 32 - (t - 2.3) * 24
  const packet = (distance: number): number => 2.5 * bell(distance, 3.8) - 0.58 * bell(distance - 6, 3.5)
  return enter * (
    packet(phase - first) * (1 - smooth((t - 2.15) / 0.65)) +
    packet(phase - returning) * smooth((t - 2.17) / 0.32) * (1 - smooth((t - 3.5) / 0.85))
  )
}

/** Resting shoulder around the selected row, sampled at the reference's settled time. */
export function settlingWave(distance: number): number {
  const age = 1.51 - Math.abs(distance) * 0.065
  const envelope = Math.max(-0.42, 2.15 - 0.17 * (Math.sqrt(distance * distance + 1) - 1))
  const rise = smooth(age / 0.62)
  const ring = age > 0 ? Math.sin(age * 5.1) * Math.exp(-age * 1.3) : 0
  return envelope * (rise + 0.18 * ring * smooth(age / 0.16))
}

/** Peak of the resting shoulder; the camera aims relative to it. */
export const SHOULDER_PEAK = settlingWave(0)

/** Outward ripple emitted by a new selection. */
export function selectionWave(distance: number, age: number): number {
  if (age < 0 || age > 3.2) return 0
  return 0.8 * smooth(age / 0.2) * Math.exp(-age * 1.15) *
    Math.cos((distance - age * 8) * 0.58) * bell(distance - age * 8, 3.4)
}

export function columnStrength(lane: number, focus: number): number {
  return 0.25 + 0.75 * bell(lane - focus, 0.55)
}

/** Quiet idle drift; maximum displacement 0.102, under 3% of a card's height. */
export function idleWave(row: number, lane: number, time: number): number {
  return 0.075 * Math.sin((time * Math.PI * 2) / 8 + row * 0.3 - lane * 0.45) +
    0.027 * Math.sin((time * Math.PI * 2) / 13 - row * 0.17 + lane * 0.3)
}

export interface Spring {
  value: number
  velocity: number
}

/** Critically damped spring step that preserves velocity across retargeting. */
export function damp(spring: Spring, target: number, rate: number, dt: number): void {
  const delta = spring.value - target
  const impulse = spring.velocity + rate * delta
  const decay = Math.exp(-rate * dt)
  spring.value = target + (delta + impulse * dt) * decay
  spring.velocity = (spring.velocity - rate * impulse * dt) * decay
}

export function springSettled(spring: Spring, target: number, epsilon = 0.0005): boolean {
  return Math.abs(spring.value - target) < epsilon && Math.abs(spring.velocity) < epsilon * 4
}

/** Free coasting first, then a short spring to the nearest resting cell. */
export class ArchiveMomentum {
  value: number
  velocity: number
  phase: 'coasting' | 'snapping' | 'idle'
  target: number
  private readonly friction = 2.4

  constructor(value: number, velocity: number) {
    this.value = value
    this.velocity = velocity
    this.phase = Math.abs(velocity) >= 0.75 ? 'coasting' : 'snapping'
    this.target = Math.round(value)
  }

  step(dt: number, coasting = this.phase === 'coasting'): void {
    if (coasting) {
      const decay = Math.exp(-this.friction * dt)
      this.value += (this.velocity * (1 - decay)) / this.friction
      this.velocity *= decay
      if (Math.abs(this.velocity) < 0.6) {
        this.target = Math.round(this.value + this.velocity / this.friction)
        this.phase = 'snapping'
      }
    } else if (this.phase === 'snapping') {
      const spring = { value: this.value, velocity: this.velocity }
      damp(spring, this.target, 10, dt)
      this.value = spring.value
      this.velocity = spring.velocity
      if (Math.abs(this.value - this.target) < 0.0001 && Math.abs(this.velocity) < 0.005) {
        this.value = this.target
        this.velocity = 0
        this.phase = 'idle'
      }
    }
  }
}

export type PlanePosition = { lane: number; row: number }

/** Both tracks coast together so the released screen direction is preserved. */
export class ArchivePlaneMomentum {
  readonly lane: ArchiveMomentum
  readonly row: ArchiveMomentum

  constructor(value: PlanePosition, velocity: PlanePosition) {
    this.lane = new ArchiveMomentum(value.lane, velocity.lane)
    this.row = new ArchiveMomentum(value.row, velocity.row)
  }

  get phase(): 'coasting' | 'snapping' | 'idle' {
    if (this.lane.phase === 'coasting' || this.row.phase === 'coasting') return 'coasting'
    return this.lane.phase === 'idle' && this.row.phase === 'idle' ? 'idle' : 'snapping'
  }

  get value(): PlanePosition {
    return { lane: this.lane.value, row: this.row.value }
  }

  step(dt: number): void {
    const coasting = this.phase === 'coasting'
    this.lane.step(dt, coasting)
    this.row.step(dt, coasting)
  }
}
