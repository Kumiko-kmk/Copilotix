import { describe, expect, it } from 'vitest'
import {
  createWaveFieldFrame,
  createWaveRidges,
  ridgeCountForHeight,
  sampleWaveField,
  updateWaveFieldFrame,
  WAVE_FIELD_CHANNELS,
  WAVE_FIELD_SAMPLES,
  type WaveFieldSample
} from '../src/renderer/components/waveField'

const sample: WaveFieldSample = { center: 0, density: 0, thickness: 0, gap: 0, slope: 0 }

describe('waveField', () => {
  it('adapts its natural ridge count to the render height', () => {
    expect(ridgeCountForHeight(700)).toBe(7)
    expect(ridgeCountForHeight(900)).toBe(9)
    expect(ridgeCountForHeight(1_500)).toBe(12)
  })

  it('creates deterministic, non-equidistant ridge strata', () => {
    const first = createWaveRidges(900, 73)
    const second = createWaveRidges(900, 73)
    expect(first).toEqual(second)
    const gaps = first.slice(1).map((ridge, index) => ridge.baseY - (first[index]?.baseY ?? 0))
    expect(new Set(gaps.map((value) => value.toFixed(4))).size).toBeGreaterThan(4)
    expect(Math.min(...gaps)).toBeGreaterThan(0.04)
  })

  it('uses continuous depth profiles and bounded three-frequency components', () => {
    const ridges = createWaveRidges(1_000, 91)
    const far = ridges[0]!
    const middle = ridges.reduce((best, ridge) => Math.abs(ridge.depth - 0.5) < Math.abs(best.depth - 0.5) ? ridge : best)
    const near = ridges.at(-1)!
    expect(far.opacityScale).toBeLessThan(middle.opacityScale)
    expect(far.opacityScale).toBeLessThan(near.opacityScale)
    expect(far.thickness).toBeGreaterThan(near.thickness)
    expect(near.amplitude).toBeGreaterThan(far.amplitude)
    for (const ridge of ridges) {
      expect(ridge.lowCycles).toBeGreaterThanOrEqual(1)
      expect(ridge.lowCycles).toBeLessThanOrEqual(2)
      expect(ridge.mediumCycles).toBeGreaterThanOrEqual(3)
      expect(ridge.mediumCycles).toBeLessThanOrEqual(5)
      expect(ridge.mediumRatio).toBeGreaterThanOrEqual(0.12)
      expect(ridge.mediumRatio).toBeLessThanOrEqual(0.22)
      expect(ridge.highCycles).toBeGreaterThanOrEqual(8)
      expect(ridge.highCycles).toBeLessThanOrEqual(13)
      expect(ridge.highJitterPixels).toBeGreaterThanOrEqual(0.3)
      expect(ridge.highJitterPixels).toBeLessThanOrEqual(1.2)
    }
  })

  it('builds a compact deterministic texture with slopes, crests, troughs and halo gaps', () => {
    const first = updateWaveFieldFrame(createWaveFieldFrame(900, 37), 4.25)
    const second = updateWaveFieldFrame(createWaveFieldFrame(900, 37), 4.25)
    expect(first.data.byteLength).toBe(first.fields * WAVE_FIELD_SAMPLES * WAVE_FIELD_CHANNELS * 4)
    expect(first.data.byteLength).toBeLessThan(100_000)
    expect(first.data).toEqual(second.data)
    const densities: number[] = []
    const gaps: number[] = []
    const slopes: number[] = []
    for (let ridge = 0; ridge < first.fields; ridge += 1) {
      for (let index = 0; index < WAVE_FIELD_SAMPLES; index += 8) {
        sampleWaveField(first, ridge, index / WAVE_FIELD_SAMPLES, sample)
        densities.push(sample.density)
        gaps.push(sample.gap)
        slopes.push(Math.abs(sample.slope))
      }
    }
    expect(Math.min(...densities)).toBeLessThan(0.2)
    expect(Math.max(...densities)).toBeGreaterThan(0.9)
    expect(Math.min(...gaps)).toBeLessThan(0.05)
    expect(Math.max(...gaps)).toBeGreaterThan(0.95)
    expect(Math.max(...slopes)).toBeGreaterThan(0.1)
  })

  it('animates different ridges independently without moving high-frequency structure into the main field', () => {
    const frame = createWaveFieldFrame(900, 123)
    updateWaveFieldFrame(frame, 0)
    const initial = Float32Array.from(frame.data)
    updateWaveFieldFrame(frame, 3)
    const deltas = frame.ridges.map((ridge) => {
      const offset = ridge.index * frame.samples * WAVE_FIELD_CHANNELS
      return Math.abs((frame.data[offset] ?? 0) - (initial[offset] ?? 0))
    })
    expect(deltas.filter((value) => value > 0.002).length).toBeGreaterThanOrEqual(frame.fields - 2)
    expect(new Set(deltas.map((value) => value.toFixed(4))).size).toBeGreaterThan(3)
  })
})
