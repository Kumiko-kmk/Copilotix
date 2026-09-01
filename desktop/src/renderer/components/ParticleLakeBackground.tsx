import React from 'react'
import {
  createLakeParticleField,
  readLakeParticle,
  sampleLakeParticle,
  type LakeParticle,
  type LakeParticleField,
  type LakeParticleSample
} from './particleLake'
import { createCanvasLakeRenderer, createWebGlLakeRenderer, type LakeRenderer } from './particleLakeRenderers'
import { createWaveFieldFrame, ridgeCountForHeight, updateWaveFieldFrame, type WaveFieldSample } from './waveField'

const FRAME_BUDGET_MS = 21
const RECOVERY_FRAME_TIME_MS = 18.5
const PERFORMANCE_SAMPLE_FRAMES = 90
const MOTION_SAMPLE_FRAMES = 30
const DENSITY_LEVELS = [1, 0.8, 0.65] as const
const QUALITY_LABELS = ['high', 'medium', 'low'] as const
const PARTICLE_COLOR_PROPERTIES = [
  '--particle-lake-1',
  '--particle-lake-2',
  '--particle-lake-3',
  '--particle-lake-4',
  '--particle-lake-5',
  '--particle-lake-6'
] as const

export default function ParticleLakeBackground(props: { seed?: number }): React.JSX.Element {
  const hostRef = React.useRef<HTMLDivElement>(null)
  const webGlCanvasRef = React.useRef<HTMLCanvasElement>(null)
  const canvasFallbackRef = React.useRef<HTMLCanvasElement>(null)

  React.useEffect(() => {
    const host = hostRef.current
    const webGlCanvas = webGlCanvasRef.current
    const fallbackCanvas = canvasFallbackRef.current
    if (!host || !webGlCanvas || !fallbackCanvas) return undefined

    const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    const colorSchemeQuery = window.matchMedia('(prefers-color-scheme: dark)')
    let waveFrame = createWaveFieldFrame(700, props.seed)
    const motionParticle: LakeParticle = {
      arc: 0,
      normal: 0,
      ridge: 0,
      phase: 0,
      speed: 18,
      size: 1,
      opacity: 0.1,
      visibility: 0.5
    }
    const motionSample: LakeParticleSample = {
      x: 0, y: 0, centerX: 0, centerY: 0, tangentX: 1, tangentY: 0, normalX: 0, normalY: 1,
      opacity: 0, size: 1, density: 0, gap: 0
    }
    const motionWaveSample: WaveFieldSample = { center: 0, density: 0, thickness: 0, gap: 0, slope: 0 }
    let renderer: LakeRenderer | null = null
    let field: LakeParticleField = { count: 0, attributes: new Float32Array() }
    let animationFrame = 0
    let width = 0
    let height = 0
    let pixelRatio = 1
    let densityIndex = 0
    let frameCount = 0
    let frameSamples = 0
    let frameTimeTotal = 0
    let previousFrameTime = 0
    let stableSampleWindows = 0
    let colors = readColors(host)

    const showRenderer = (kind: LakeRenderer['kind'] | 'css'): void => {
      webGlCanvas.hidden = kind !== 'webgl2'
      fallbackCanvas.hidden = kind !== 'canvas2d'
      host.dataset.renderer = kind
    }

    const selectRenderer = (preferWebGl: boolean): void => {
      renderer?.dispose()
      renderer = preferWebGl ? createWebGlLakeRenderer(webGlCanvas) : null
      renderer ??= createCanvasLakeRenderer(fallbackCanvas)
      showRenderer(renderer?.kind ?? 'css')
      renderer?.setPalette(colors)
      renderer?.setWaveField(waveFrame)
    }

    const rebuild = (): void => {
      const bounds = host.getBoundingClientRect()
      width = Math.max(1, Math.round(bounds.width))
      height = Math.max(1, Math.round(bounds.height))
      pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5)
      if (!renderer) {
        host.dataset.particleCount = '0'
        return
      }
      if (waveFrame.fields !== ridgeCountForHeight(height)) waveFrame = createWaveFieldFrame(height, props.seed)
      renderer.resize(width, height, pixelRatio)
      field = createLakeParticleField(width, height, waveFrame.ridges, props.seed, DENSITY_LEVELS[densityIndex], renderer.kind)
      renderer.setField(field)
      renderer.setWaveField(waveFrame)
      host.dataset.particleCount = String(field.count)
      host.dataset.ridgeCount = String(waveFrame.fields)
      host.dataset.depthProfile = summarizeDepthProfile(waveFrame.ridges)
      host.dataset.qualityLevel = QUALITY_LABELS[densityIndex]
    }

    const updateMotionSample = (timeSeconds: number): void => {
      if (field.count === 0) return
      readLakeParticle(field, 0, motionParticle)
      sampleLakeParticle(motionParticle, waveFrame, timeSeconds, width, height, motionSample, motionWaveSample)
      host.dataset.motionSample = `${motionSample.x.toFixed(2)},${motionSample.y.toFixed(2)}`
      host.dataset.waveSample = `${motionWaveSample.center.toFixed(4)},${motionWaveSample.density.toFixed(4)},${motionWaveSample.gap.toFixed(4)}`
      host.dataset.tangentSample = `${motionSample.tangentX.toFixed(4)},${motionSample.tangentY.toFixed(4)},${motionSample.normalX.toFixed(4)},${motionSample.normalY.toFixed(4)}`
      host.dataset.frameCount = String(frameCount)
    }

    const draw = (timeMilliseconds: number): void => {
      if (!renderer) {
        host.dataset.renderState = 'fallback'
        return
      }
      const timeSeconds = timeMilliseconds / 1000
      updateWaveFieldFrame(waveFrame, timeSeconds)
      renderer.setWaveField(waveFrame)
      renderer.draw(timeSeconds, width, height, pixelRatio)
      frameCount += 1
      if (frameCount === 1 || frameCount % MOTION_SAMPLE_FRAMES === 0) updateMotionSample(timeSeconds)
      host.dataset.renderState = reducedMotionQuery.matches ? 'static' : 'animated'
    }

    const schedule = (): void => {
      if (!renderer || reducedMotionQuery.matches || document.hidden) return
      animationFrame = window.requestAnimationFrame(tick)
    }

    const tick = (time: number): void => {
      if (previousFrameTime > 0) {
        frameTimeTotal += Math.min(50, time - previousFrameTime)
        frameSamples += 1
      }
      previousFrameTime = time
      draw(time)

      if (frameSamples >= PERFORMANCE_SAMPLE_FRAMES) {
        const averageFrameTime = frameTimeTotal / frameSamples
        host.dataset.averageFrameMs = averageFrameTime.toFixed(2)
        if (averageFrameTime > FRAME_BUDGET_MS && densityIndex < DENSITY_LEVELS.length - 1) {
          densityIndex += 1
          stableSampleWindows = 0
          rebuild()
        } else if (averageFrameTime < RECOVERY_FRAME_TIME_MS && densityIndex > 0) {
          stableSampleWindows += 1
          if (stableSampleWindows >= 4) {
            densityIndex -= 1
            stableSampleWindows = 0
            rebuild()
          }
        } else {
          stableSampleWindows = 0
        }
        frameSamples = 0
        frameTimeTotal = 0
      }
      schedule()
    }

    const restart = (): void => {
      window.cancelAnimationFrame(animationFrame)
      animationFrame = 0
      previousFrameTime = 0
      if (document.hidden) {
        host.dataset.renderState = 'paused'
        return
      }
      if (reducedMotionQuery.matches) {
        draw(0)
        return
      }
      schedule()
    }

    const handleThemeChange = (): void => {
      colors = readColors(host)
      renderer?.setPalette(colors)
      draw(reducedMotionQuery.matches ? 0 : performance.now())
    }

    const handleContextLost = (event: Event): void => {
      event.preventDefault()
      selectRenderer(false)
      rebuild()
      draw(performance.now())
    }

    const handleContextRestored = (): void => {
      selectRenderer(true)
      rebuild()
      draw(performance.now())
      restart()
    }

    const resizeObserver = new ResizeObserver(() => {
      rebuild()
      draw(reducedMotionQuery.matches ? 0 : performance.now())
    })

    selectRenderer(true)
    resizeObserver.observe(host)
    document.addEventListener('visibilitychange', restart)
    reducedMotionQuery.addEventListener('change', restart)
    colorSchemeQuery.addEventListener('change', handleThemeChange)
    webGlCanvas.addEventListener('webglcontextlost', handleContextLost)
    webGlCanvas.addEventListener('webglcontextrestored', handleContextRestored)
    rebuild()
    draw(0)
    restart()

    return () => {
      window.cancelAnimationFrame(animationFrame)
      resizeObserver.disconnect()
      document.removeEventListener('visibilitychange', restart)
      reducedMotionQuery.removeEventListener('change', restart)
      colorSchemeQuery.removeEventListener('change', handleThemeChange)
      webGlCanvas.removeEventListener('webglcontextlost', handleContextLost)
      webGlCanvas.removeEventListener('webglcontextrestored', handleContextRestored)
      renderer?.dispose()
    }
  }, [props.seed])

  return (
    <div ref={hostRef} className="particle-lake" data-testid="particle-lake" aria-hidden="true">
      <canvas ref={webGlCanvasRef} data-particle-canvas="webgl2" />
      <canvas ref={canvasFallbackRef} data-particle-canvas="canvas2d" hidden />
    </div>
  )
}

function readColors(element: HTMLElement): string[] {
  const styles = getComputedStyle(element)
  return PARTICLE_COLOR_PROPERTIES.map((property) => styles.getPropertyValue(property).trim())
}

function summarizeDepthProfile(ridges: readonly { depth: number; opacityScale: number; thickness: number }[]): string {
  const totals = [0, 0, 0]
  const counts = [0, 0, 0]
  for (const ridge of ridges) {
    const index = ridge.depth < 1 / 3 ? 0 : ridge.depth < 2 / 3 ? 1 : 2
    totals[index] = (totals[index] ?? 0) + ridge.opacityScale / Math.max(0.001, ridge.thickness)
    counts[index] = (counts[index] ?? 0) + 1
  }
  return totals.map((total, index) => (total / Math.max(1, counts[index] ?? 0)).toFixed(3)).join(',')
}
