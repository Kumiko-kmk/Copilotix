import { describe, expect, it } from 'vitest'
import {
  createLakeParticleField,
  particleCountForSize,
  readLakeParticle,
  sampleLakeParticle,
  type LakeParticle,
  type LakeParticleSample
} from '../src/renderer/components/particleLake'
import {
  createWaveFieldFrame,
  sampleWaveField,
  updateWaveFieldFrame,
  type WaveFieldSample
} from '../src/renderer/components/waveField'

const particle: LakeParticle = {
  arc: 0, normal: 0, ridge: 0, phase: 0, speed: 18, size: 1, opacity: 0.1, visibility: 0.5
}
const waveSample: WaveFieldSample = { center: 0, density: 0, thickness: 0, gap: 0, slope: 0 }

function emptySample(): LakeParticleSample {
  return {
    x: 0, y: 0, centerX: 0, centerY: 0, tangentX: 1, tangentY: 0, normalX: 0, normalY: 1,
    opacity: 0, size: 0, density: 0, gap: 0
  }
}

describe('particleLake', () => {
  it('keeps the high-density WebGL budget and bounded Canvas fallback', () => {
    expect(particleCountForSize(1100, 700)).toBe(128_333)
    expect(particleCountForSize(1440, 900)).toBe(216_000)
    expect(particleCountForSize(2160, 1350)).toBe(270_000)
    expect(particleCountForSize(1100, 700, 1, 'canvas2d')).toBe(22_000)
    expect(particleCountForSize(1440, 900, 1, 'canvas2d')).toBe(30_000)
    expect(particleCountForSize(1440, 900, 0.65)).toBe(140_400)
  })

  it('creates deterministic particles with natural depth weighting and mixed normal widths', () => {
    const frame = createWaveFieldFrame(900, 42)
    const first = createLakeParticleField(1100, 700, frame.ridges, 42, 1, 'canvas2d')
    const second = createLakeParticleField(1100, 700, frame.ridges, 42, 1, 'canvas2d')
    expect(first.attributes).toEqual(second.attributes)
    const depthCounts = [0, 0, 0]
    let core = 0
    let body = 0
    let halo = 0
    for (let index = 0; index < 20_000; index += 1) {
      readLakeParticle(first, index, particle)
      const depth = frame.ridges[particle.ridge]?.depth ?? 0
      const depthIndex = depth < 1 / 3 ? 0 : depth < 2 / 3 ? 1 : 2
      depthCounts[depthIndex] = (depthCounts[depthIndex] ?? 0) + 1
      const distance = Math.abs(particle.normal)
      if (distance <= 0.3) core += 1
      else if (distance <= 1.2) body += 1
      else halo += 1
      expect(particle.size).toBeGreaterThanOrEqual(0.5)
      expect(particle.size).toBeLessThanOrEqual(1.8)
      expect(particle.speed).toBeGreaterThanOrEqual(18)
      expect(particle.speed).toBeLessThanOrEqual(42)
    }
    expect(depthCounts[1]).toBeGreaterThan(depthCounts[0] ?? 0)
    expect(depthCounts[2]).toBeGreaterThan(depthCounts[0] ?? 0)
    expect(core).toBeGreaterThan(3_000)
    expect(body).toBeGreaterThan(5_000)
    expect(core).toBeLessThan(10_000)
    expect(halo).toBeGreaterThan(500)
  })

  it('places thickness strictly on the local normal rather than the screen Y axis', () => {
    const frame = updateWaveFieldFrame(createWaveFieldFrame(900, 77), 2)
    const normalParticle: LakeParticle = {
      arc: 0.34, normal: 1.1, ridge: 4, phase: 0.4, speed: 24, size: 1, opacity: 0.1, visibility: 0
    }
    const output = emptySample()
    sampleLakeParticle(normalParticle, frame, 1, 1440, 900, output, waveSample)
    let deltaX = output.x - output.centerX
    if (deltaX > 720) deltaX -= 1440
    if (deltaX < -720) deltaX += 1440
    const deltaY = output.y - output.centerY
    const tangentProjection = Math.abs(deltaX * output.tangentX + deltaY * output.tangentY)
    const normalProjection = Math.abs(deltaX * output.normalX + deltaY * output.normalY)
    expect(normalProjection).toBeGreaterThan(5)
    expect(tangentProjection / normalProjection).toBeLessThan(0.1)
    expect(Math.abs(output.normalX)).toBeGreaterThan(0.01)
  })

  it('moves ridge centers along the local tangent with arc-length compensation', () => {
    const frame = updateWaveFieldFrame(createWaveFieldFrame(900, 19), 0)
    const movingParticle: LakeParticle = {
      arc: 0.42, normal: 0, ridge: 5, phase: 0, speed: 32, size: 1, opacity: 0.1, visibility: 0
    }
    const initial = emptySample()
    const later = emptySample()
    sampleLakeParticle(movingParticle, frame, 0.5, 1440, 900, initial, waveSample)
    sampleLakeParticle(movingParticle, frame, 0.51, 1440, 900, later, waveSample)
    const dx = later.centerX - initial.centerX
    const dy = later.centerY - initial.centerY
    const length = Math.hypot(dx, dy)
    const alignment = (dx * initial.tangentX + dy * initial.tangentY) / Math.max(0.001, length)
    expect(alignment).toBeGreaterThan(0.9)
  })

  it('keeps the core visible where the halo gap is fully broken', () => {
    const frame = updateWaveFieldFrame(createWaveFieldFrame(900, 151), 3)
    let ridgeIndex = 0
    let normalizedX = 0
    let minimumGap = 1
    for (let ridge = 0; ridge < frame.fields; ridge += 1) {
      for (let index = 0; index < frame.samples; index += 1) {
        sampleWaveField(frame, ridge, index / frame.samples, waveSample)
        if (waveSample.gap < minimumGap) {
          minimumGap = waveSample.gap
          ridgeIndex = ridge
          normalizedX = index / frame.samples
        }
      }
    }
    expect(minimumGap).toBeLessThan(0.05)
    const coreParticle: LakeParticle = {
      arc: normalizedX, normal: 0, ridge: ridgeIndex, phase: 0, speed: 0, size: 1, opacity: 0.1, visibility: 1
    }
    const haloParticle = { ...coreParticle, normal: 2 }
    const core = emptySample()
    const halo = emptySample()
    sampleLakeParticle(coreParticle, frame, 0, 1440, 900, core, waveSample)
    sampleLakeParticle(haloParticle, frame, 0, 1440, 900, halo, waveSample)
    expect(core.opacity).toBeGreaterThan(0.01)
    expect(halo.opacity).toBeLessThan(core.opacity * 0.1)
  })
})
