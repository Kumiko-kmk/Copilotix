import {
  sampleWaveField,
  type WaveFieldFrame,
  type WaveFieldSample,
  type WaveRidgeDescriptor
} from './waveField'

export const PARTICLE_ATTRIBUTE_STRIDE = 8

const TAU = Math.PI * 2

export type LakeRendererKind = 'webgl2' | 'canvas2d'

export type LakeParticle = {
  arc: number
  normal: number
  ridge: number
  phase: number
  speed: number
  size: number
  opacity: number
  visibility: number
}

export type LakeParticleField = {
  count: number
  attributes: Float32Array
}

export type LakeParticleSample = {
  x: number
  y: number
  centerX: number
  centerY: number
  tangentX: number
  tangentY: number
  normalX: number
  normalY: number
  opacity: number
  size: number
  density: number
  gap: number
}

export function particleCountForSize(
  width: number,
  height: number,
  density = 1,
  renderer: LakeRendererKind = 'webgl2'
): number {
  const area = Math.max(0, width) * Math.max(0, height)
  const baseCount = renderer === 'webgl2'
    ? clamp(Math.floor(area / 6), 128_000, 270_000)
    : clamp(Math.floor(area / 35), 18_000, 30_000)
  return Math.round(baseCount * clamp(density, 0.65, 1))
}

export function createLakeParticleField(
  width: number,
  height: number,
  ridges: readonly WaveRidgeDescriptor[],
  seed = 12_079,
  density = 1,
  renderer: LakeRendererKind = 'webgl2'
): LakeParticleField {
  const random = mulberry32(seed)
  const count = particleCountForSize(width, height, density, renderer)
  const attributes = new Float32Array(count * PARTICLE_ATTRIBUTE_STRIDE)
  const cumulativeWeights = buildCumulativeWeights(ridges)

  for (let index = 0; index < count; index += 1) {
    const ridgeIndex = selectRidge(cumulativeWeights, random())
    const ridge = ridges[ridgeIndex] ?? ridges[0]
    const depth = ridge?.depth ?? 0.5
    const offset = index * PARTICLE_ATTRIBUTE_STRIDE
    const distribution = random()
    const normal = distribution < 0.3
      ? gaussian(random, 4) * 0.2
      : distribution < 0.8
        ? gaussian(random, 6) * 0.72
        : gaussian(random, 6) * 1.42
    const sizeBucket = random()
    const baseSize = sizeBucket < 0.82
      ? 0.5 + random() * 0.6
      : sizeBucket < 0.97
        ? 1.1 + random() * 0.4
        : 1.5 + random() * 0.3
    const opacityScale = ridge?.opacityScale ?? 1
    const sizeScale = ridge?.sizeScale ?? 1

    attributes[offset] = random()
    attributes[offset + 1] = clamp(normal, -2.7, 2.7)
    attributes[offset + 2] = ridgeIndex
    attributes[offset + 3] = random() * TAU
    attributes[offset + 4] = 18 + depth * 17 + random() * 7
    attributes[offset + 5] = clamp(baseSize * sizeScale, 0.5, 1.8)
    attributes[offset + 6] = clamp((0.04 + random() * random() * 0.14) * opacityScale, 0.03, 0.2)
    attributes[offset + 7] = random()
  }

  return { count, attributes }
}

export function readLakeParticle(field: LakeParticleField, index: number, output: LakeParticle): LakeParticle {
  const boundedIndex = clamp(Math.floor(index), 0, Math.max(0, field.count - 1))
  const offset = boundedIndex * PARTICLE_ATTRIBUTE_STRIDE
  output.arc = field.attributes[offset] ?? 0
  output.normal = field.attributes[offset + 1] ?? 0
  output.ridge = field.attributes[offset + 2] ?? 0
  output.phase = field.attributes[offset + 3] ?? 0
  output.speed = field.attributes[offset + 4] ?? 18
  output.size = field.attributes[offset + 5] ?? 0.8
  output.opacity = field.attributes[offset + 6] ?? 0.08
  output.visibility = field.attributes[offset + 7] ?? 0.5
  return output
}

export function sampleLakeParticle(
  particle: LakeParticle,
  waveFrame: WaveFieldFrame,
  timeSeconds: number,
  width: number,
  height: number,
  output: LakeParticleSample,
  waveSample: WaveFieldSample
): LakeParticleSample {
  const safeWidth = Math.max(1, width)
  const safeHeight = Math.max(1, height)
  const distance = particle.speed * timeSeconds
  const approximateX = wrap01(particle.arc + distance / safeWidth)
  sampleWaveField(waveFrame, particle.ridge, approximateX, waveSample)
  const firstArcScale = Math.hypot(1, waveSample.slope * safeHeight / safeWidth)
  const normalizedX = wrap01(particle.arc + distance / (safeWidth * firstArcScale))
  sampleWaveField(waveFrame, particle.ridge, normalizedX, waveSample)

  const slopePixels = waveSample.slope * safeHeight / safeWidth
  const tangentLength = Math.hypot(1, slopePixels)
  const tangentX = 1 / tangentLength
  const tangentY = slopePixels / tangentLength
  const normalX = -tangentY
  const normalY = tangentX
  const ridge = waveFrame.ridges[clamp(Math.floor(particle.ridge), 0, waveFrame.fields - 1)]
  const highCycles = ridge?.highCycles ?? 10
  const highJitter = Math.sin(normalizedX * TAU * highCycles + particle.phase + timeSeconds * 0.74) * (ridge?.highJitterPixels ?? 0.7)
  const alongJitter = Math.sin(timeSeconds * 0.34 + particle.phase) * 2.6
  const normalDistance = particle.normal * waveSample.thickness * safeHeight + highJitter
  const baseX = normalizedX * safeWidth
  const baseY = waveSample.center * safeHeight
  const centerX = baseX + tangentX * alongJitter
  const centerY = baseY + tangentY * alongJitter
  const verticalWeight = Math.exp(-0.5 * particle.normal * particle.normal)
  const coreWeight = 1 - smoothstep(0.2, 0.52, Math.abs(particle.normal))
  const haloGate = waveSample.gap + (1 - waveSample.gap) * coreWeight
  const localDensity = waveSample.density * verticalWeight * haloGate
  const thresholdFade = clamp((localDensity - particle.visibility) * 8 + 0.5, 0, 1)
  const continuousCore = coreWeight * (0.34 + waveSample.density * 0.46)
  const fade = Math.max(thresholdFade, continuousCore)
  const crestBoost = 0.35 + waveSample.density * 3.25

  output.x = wrap(centerX + normalX * normalDistance, safeWidth)
  output.y = centerY + normalY * normalDistance
  output.centerX = wrap(centerX, safeWidth)
  output.centerY = centerY
  output.tangentX = tangentX
  output.tangentY = tangentY
  output.normalX = normalX
  output.normalY = normalY
  output.opacity = clamp(particle.opacity * crestBoost * (0.28 + verticalWeight * 0.72) * fade, 0, 0.8)
  output.size = particle.size
  output.density = waveSample.density
  output.gap = waveSample.gap
  return output
}

function buildCumulativeWeights(ridges: readonly WaveRidgeDescriptor[]): number[] {
  const cumulative: number[] = []
  let total = 0
  for (const ridge of ridges) {
    total += ridge.allocationWeight
    cumulative.push(total)
  }
  if (total <= 0) return ridges.map((_, index) => index + 1)
  for (let index = 0; index < cumulative.length; index += 1) cumulative[index] = (cumulative[index] ?? total) / total
  return cumulative
}

function selectRidge(cumulative: readonly number[], value: number): number {
  for (let index = 0; index < cumulative.length; index += 1) {
    if (value <= (cumulative[index] ?? 1)) return index
  }
  return Math.max(0, cumulative.length - 1)
}

function gaussian(random: () => number, samples: number): number {
  let sum = 0
  for (let index = 0; index < samples; index += 1) sum += random()
  return (sum - samples / 2) * Math.sqrt(12 / samples)
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

function wrap(value: number, length: number): number {
  return ((value % length) + length) % length
}

function wrap01(value: number): number {
  return value - Math.floor(value)
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const amount = clamp((value - edge0) / (edge1 - edge0), 0, 1)
  return amount * amount * (3 - 2 * amount)
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}
