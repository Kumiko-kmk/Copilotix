export const WAVE_FIELD_SAMPLES = 512
export const WAVE_FIELD_CHANNELS = 4
export const MIN_WAVE_RIDGES = 7
export const MAX_WAVE_RIDGES = 12

const TAU = Math.PI * 2

export type WaveRidgeDescriptor = {
  readonly index: number
  readonly baseY: number
  readonly depth: number
  readonly amplitude: number
  readonly thickness: number
  readonly opacityScale: number
  readonly sizeScale: number
  readonly allocationWeight: number
  readonly direction: number
  readonly travelSpeed: number
  readonly lowCycles: number
  readonly mediumCycles: number
  readonly highCycles: number
  readonly mediumRatio: number
  readonly highJitterPixels: number
  readonly phase: number
  readonly secondaryPhase: number
}

export type WaveFieldFrame = {
  readonly fields: number
  readonly samples: number
  readonly data: Float32Array
  readonly centers: Float32Array
  readonly broadCenters: Float32Array
  readonly ridges: readonly WaveRidgeDescriptor[]
  readonly seed: number
}

export type WaveFieldSample = {
  center: number
  density: number
  thickness: number
  gap: number
  slope: number
}

export function ridgeCountForHeight(renderHeight: number): number {
  return clamp(Math.round(Math.max(1, renderHeight) / 95), MIN_WAVE_RIDGES, MAX_WAVE_RIDGES)
}

export function createWaveRidges(renderHeight: number, seed = 12_079): readonly WaveRidgeDescriptor[] {
  const count = ridgeCountForHeight(renderHeight)
  const random = mulberry32(seed ^ count * 0x9e37)
  const margin = 0.045
  const span = 1 - margin * 2
  const ridges: WaveRidgeDescriptor[] = []

  for (let index = 0; index < count; index += 1) {
    const stratum = (index + 0.5) / count
    const jitter = (random() - 0.5) * 0.46 / count
    const baseY = clamp(margin + (stratum + jitter) * span, margin, 1 - margin)
    const depth = smoothstep(0.02, 0.98, baseY)
    const far = 1 - smoothstep(0.2, 0.5, depth)
    const middle = smoothstep(0.12, 0.42, depth) * (1 - smoothstep(0.68, 0.95, depth))
    const near = smoothstep(0.56, 0.92, depth)
    const amplitude = 0.028 + depth * 0.056 + middle * 0.012
    const thickness = 0.043 + far * 0.025 + middle * 0.009 - near * 0.006
    const lowCycles = random() < 0.72 ? 1 : 2

    ridges.push({
      index,
      baseY,
      depth,
      amplitude,
      thickness,
      opacityScale: 0.85 + middle * 0.35 + near * 0.5,
      sizeScale: 0.78 + middle * 0.14 + near * 0.3,
      allocationWeight: 0.9 + middle * 0.8 + near * 0.65,
      direction: random() < 0.82 ? 1 : -1,
      travelSpeed: 0.022 + depth * 0.025 + random() * 0.009,
      lowCycles,
      mediumCycles: 3 + Math.floor(random() * 3),
      highCycles: 8 + Math.floor(random() * 6),
      mediumRatio: 0.12 + random() * 0.1,
      highJitterPixels: 0.3 + depth * 0.9,
      phase: random() * TAU,
      secondaryPhase: random() * TAU
    })
  }

  return ridges
}

export function createWaveFieldFrame(renderHeight: number, seed = 12_079): WaveFieldFrame {
  const ridges = createWaveRidges(renderHeight, seed)
  const length = ridges.length * WAVE_FIELD_SAMPLES
  return {
    fields: ridges.length,
    samples: WAVE_FIELD_SAMPLES,
    data: new Float32Array(length * WAVE_FIELD_CHANNELS),
    centers: new Float32Array(length),
    broadCenters: new Float32Array(length),
    ridges,
    seed
  }
}

export function updateWaveFieldFrame(frame: WaveFieldFrame, timeSeconds: number): WaveFieldFrame {
  for (const ridge of frame.ridges) {
    const travel = timeSeconds * ridge.travelSpeed * ridge.direction
    for (let index = 0; index < frame.samples; index += 1) {
      const x = index / frame.samples
      const main = Math.sin(TAU * (x * ridge.lowCycles + travel) + ridge.phase)
      const secondary = Math.sin(TAU * (x * (ridge.lowCycles + 1) - travel * 0.57) + ridge.secondaryPhase) * 0.32
      const broadCenter = ridge.baseY + ridge.amplitude * (main + secondary)
      const medium = periodicValueNoise(
        x * ridge.mediumCycles + timeSeconds * ridge.travelSpeed * 1.7 * ridge.direction,
        ridge.mediumCycles,
        frame.seed + ridge.index * 181
      )
      const center = broadCenter + ridge.amplitude * ridge.mediumRatio * medium
      const sampleIndex = ridge.index * frame.samples + index
      frame.broadCenters[sampleIndex] = broadCenter
      frame.centers[sampleIndex] = center
    }
  }

  for (const ridge of frame.ridges) {
    for (let index = 0; index < frame.samples; index += 1) {
      const previousIndex = ridge.index * frame.samples + wrapIndex(index - 1, frame.samples)
      const sampleIndex = ridge.index * frame.samples + index
      const nextIndex = ridge.index * frame.samples + wrapIndex(index + 1, frame.samples)
      const previous = frame.broadCenters[previousIndex] ?? ridge.baseY
      const broadCenter = frame.broadCenters[sampleIndex] ?? ridge.baseY
      const next = frame.broadCenters[nextIndex] ?? ridge.baseY
      const center = frame.centers[sampleIndex] ?? broadCenter
      const slope = Math.min(1, Math.abs(next - previous) * frame.samples * 0.42)
      const signedCurvature = (next - broadCenter * 2 + previous) * frame.samples * frame.samples
      const crest = smoothstep(0.2, 3.4, signedCurvature)
      const trough = smoothstep(0.2, 3.4, -signedCurvature)
      const x = index / frame.samples
      const mediumDensity = periodicValueNoise(
        x * ridge.mediumCycles - timeSeconds * ridge.travelSpeed,
        ridge.mediumCycles,
        frame.seed + ridge.index * 277
      )
      const haloNoise = periodicValueNoise(
        x * (ridge.mediumCycles + 2) + timeSeconds * ridge.travelSpeed * 1.25,
        ridge.mediumCycles + 2,
        frame.seed + ridge.index * 389
      )
      const density = clamp(0.58 + crest * 0.42 - trough * 0.48 + slope * 0.08 + mediumDensity * 0.08, 0.06, 1)
      const gap = smoothstep(-0.74, -0.48, haloNoise + crest * 0.08)
      const thickness = ridge.thickness * (0.88 + (mediumDensity * 0.5 + 0.5) * 0.24)
      const offset = sampleIndex * WAVE_FIELD_CHANNELS
      frame.data[offset] = center
      frame.data[offset + 1] = density
      frame.data[offset + 2] = thickness
      frame.data[offset + 3] = gap
    }
  }

  return frame
}

export function sampleWaveField(frame: WaveFieldFrame, ridgeIndex: number, normalizedX: number, output: WaveFieldSample): WaveFieldSample {
  const boundedRidge = clamp(Math.floor(ridgeIndex), 0, frame.fields - 1)
  const position = wrap01(normalizedX) * frame.samples
  const left = Math.floor(position)
  const right = wrapIndex(left + 1, frame.samples)
  const mixAmount = position - left
  const leftOffset = (boundedRidge * frame.samples + wrapIndex(left, frame.samples)) * WAVE_FIELD_CHANNELS
  const rightOffset = (boundedRidge * frame.samples + right) * WAVE_FIELD_CHANNELS

  output.center = mix(frame.data[leftOffset] ?? 0, frame.data[rightOffset] ?? 0, mixAmount)
  output.density = mix(frame.data[leftOffset + 1] ?? 0, frame.data[rightOffset + 1] ?? 0, mixAmount)
  output.thickness = mix(frame.data[leftOffset + 2] ?? 0.05, frame.data[rightOffset + 2] ?? 0.05, mixAmount)
  output.gap = mix(frame.data[leftOffset + 3] ?? 0, frame.data[rightOffset + 3] ?? 0, mixAmount)
  output.slope = ((frame.data[rightOffset] ?? output.center) - (frame.data[leftOffset] ?? output.center)) * frame.samples
  return output
}

function periodicValueNoise(position: number, period: number, seed: number): number {
  const base = Math.floor(position)
  const fraction = position - base
  const left = hash01(wrapIndex(base, period), seed) * 2 - 1
  const right = hash01(wrapIndex(base + 1, period), seed) * 2 - 1
  const eased = fraction * fraction * fraction * (fraction * (fraction * 6 - 15) + 10)
  return mix(left, right, eased)
}

function hash01(value: number, seed: number): number {
  const sine = Math.sin(value * 127.1 + seed * 311.7) * 43_758.545_312_3
  return sine - Math.floor(sine)
}

function mulberry32(seed: number): () => number {
  let value = seed >>> 0
  return () => {
    value += 0x6d2b79f5
    let next = value
    next = Math.imul(next ^ (next >>> 15), next | 1)
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61)
    return ((next ^ (next >>> 14)) >>> 0) / 4_294_967_296
  }
}

function wrapIndex(value: number, length: number): number {
  return ((value % length) + length) % length
}

function wrap01(value: number): number {
  return value - Math.floor(value)
}

function mix(left: number, right: number, amount: number): number {
  return left + (right - left) * amount
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const amount = clamp((value - edge0) / (edge1 - edge0), 0, 1)
  return amount * amount * (3 - 2 * amount)
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}
