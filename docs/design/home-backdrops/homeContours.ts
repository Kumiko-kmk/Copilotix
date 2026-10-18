/**
 * Home backdrop: an ink contour survey. Two drifting layers of value noise form a slowly changing
 * terrain drawn as hairline contours (marching squares); the pointer raises a soft hill the lines
 * wrap around, and a scan line sweeps down now and then, lighting the contours it has just crossed
 * in the accent, as the archive scans its cards. Paused while the window is hidden or unfocused.
 */
const CELL = 14
const LEVELS = 15
const LEVEL_START = 0.17
const LEVEL_STEP = 0.045
const FRAME_MS = 1000 / 30
const SCAN_PERIOD = 17
const SCAN_TRAVEL = 7.5
const INK = '47, 42, 36'
const ACCENT = '91, 88, 214'

function hash(x: number, y: number): number {
  const value = Math.sin(x * 127.1 + y * 311.7) * 43_758.5453
  return value - Math.floor(value)
}

function valueNoise(x: number, y: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = x - ix
  const fy = y - iy
  const sx = fx * fx * (3 - 2 * fx)
  const sy = fy * fy * (3 - 2 * fy)
  const top = hash(ix, iy) + (hash(ix + 1, iy) - hash(ix, iy)) * sx
  const bottom = hash(ix, iy + 1) + (hash(ix + 1, iy + 1) - hash(ix, iy + 1)) * sx
  return top + (bottom - top) * sy
}

export interface ContourSurvey {
  dispose(): void
}

export function startContourSurvey(canvas: HTMLCanvasElement, readout: HTMLElement | null): ContourSurvey | null {
  const context = typeof CanvasRenderingContext2D === 'undefined' ? null : canvas.getContext('2d')
  if (!context) return null
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  let width = 0
  let height = 0
  let columns = 0
  let rows = 0
  let field = new Float32Array(0)
  let frame: number | null = null
  let last = 0
  let elapsed = 0
  const pointer = { x: 0, y: 0, targetX: 0, targetY: 0, strength: 0, targetStrength: 0 }

  const resize = (): void => {
    const bounds = canvas.getBoundingClientRect()
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5)
    width = Math.max(1, bounds.width)
    height = Math.max(1, bounds.height)
    canvas.width = Math.round(width * ratio)
    canvas.height = Math.round(height * ratio)
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    columns = Math.ceil(width / CELL) + 2
    rows = Math.ceil(height / CELL) + 2
    field = new Float32Array(columns * rows)
    if (!pointer.strength) {
      pointer.x = pointer.targetX = width * 0.5
      pointer.y = pointer.targetY = height * 0.45
    }
  }

  const sample = (time: number): void => {
    const drift = time * 0.022
    const radius = Math.max(150, Math.min(width, height) * 0.2)
    const inverse = 1 / (radius * radius)
    for (let row = 0; row < rows; row++) {
      const y = row * CELL
      for (let column = 0; column < columns; column++) {
        const x = column * CELL
        const broad = valueNoise(x / 420 + drift, y / 420 - drift * 0.6)
        const fine = valueNoise(x / 190 - drift * 1.4 + 17, y / 190 + drift * 0.8 + 5)
        const dx = x - pointer.x
        const dy = y - pointer.y
        const hill = pointer.strength * 0.2 * Math.exp(-(dx * dx + dy * dy) * inverse)
        field[row * columns + column] = broad * 0.68 + fine * 0.32 + hill
      }
    }
  }

  /** Marching squares for one level, appended to a shared path. */
  const trace = (path: Path2D, level: number): void => {
    for (let row = 0; row < rows - 1; row++) {
      for (let column = 0; column < columns - 1; column++) {
        const index = row * columns + column
        const a = field[index]!
        const b = field[index + 1]!
        const c = field[index + columns + 1]!
        const d = field[index + columns]!
        const code = (a > level ? 8 : 0) | (b > level ? 4 : 0) | (c > level ? 2 : 0) | (d > level ? 1 : 0)
        if (code === 0 || code === 15) continue
        const x = column * CELL
        const y = row * CELL
        const top = x + ((level - a) / (b - a)) * CELL
        const right = y + ((level - b) / (c - b)) * CELL
        const bottom = x + ((level - d) / (c - d)) * CELL
        const left = y + ((level - a) / (d - a)) * CELL
        const segment = (x1: number, y1: number, x2: number, y2: number): void => {
          path.moveTo(x1, y1)
          path.lineTo(x2, y2)
        }
        switch (code) {
          case 1: case 14: segment(x, left, bottom, y + CELL); break
          case 2: case 13: segment(bottom, y + CELL, x + CELL, right); break
          case 3: case 12: segment(x, left, x + CELL, right); break
          case 4: case 11: segment(top, y, x + CELL, right); break
          case 5: segment(x, left, top, y); segment(bottom, y + CELL, x + CELL, right); break
          case 6: case 9: segment(top, y, bottom, y + CELL); break
          case 7: case 8: segment(x, left, top, y); break
          case 10: segment(top, y, x + CELL, right); segment(x, left, bottom, y + CELL); break
        }
      }
    }
  }

  const draw = (time: number): void => {
    sample(time)
    const minor = new Path2D()
    const index = new Path2D()
    for (let level = 0; level < LEVELS; level++) trace(level % 4 === 2 ? index : minor, LEVEL_START + level * LEVEL_STEP)
    context.globalCompositeOperation = 'source-over'
    context.clearRect(0, 0, width, height)
    context.lineJoin = 'round'
    context.lineWidth = 0.8
    context.strokeStyle = `rgba(${INK}, .15)`
    context.stroke(minor)
    context.lineWidth = 1.1
    context.strokeStyle = `rgba(${INK}, .26)`
    context.stroke(index)

    // The scan: lines it has just crossed glow in the accent, fading upward behind it.
    const phase = time % SCAN_PERIOD
    if (!reduced && phase < SCAN_TRAVEL) {
      const scanY = -40 + (phase / SCAN_TRAVEL) * (height + 80)
      const trail = Math.min(220, height * 0.28)
      const glow = context.createLinearGradient(0, scanY - trail, 0, scanY)
      glow.addColorStop(0, `rgba(${ACCENT}, 0)`)
      glow.addColorStop(1, `rgba(${ACCENT}, .75)`)
      context.save()
      context.beginPath()
      context.rect(0, scanY - trail, width, trail)
      context.clip()
      context.strokeStyle = glow
      context.lineWidth = 1.2
      context.stroke(minor)
      context.stroke(index)
      context.restore()
      context.fillStyle = `rgba(${ACCENT}, .35)`
      context.fillRect(0, scanY, width, 1)
      for (let x = 0; x < width; x += 48) context.fillRect(x, scanY - 3, 1, 7)
    }

    // Keep the hero calm: the survey fades out toward the centre of the page.
    context.globalCompositeOperation = 'destination-out'
    context.save()
    context.translate(width * 0.5, height * 0.48)
    context.scale(1, 0.62)
    const reach = width * 0.42
    const hole = context.createRadialGradient(0, 0, 0, 0, 0, reach)
    hole.addColorStop(0, 'rgba(0, 0, 0, .9)')
    hole.addColorStop(0.55, 'rgba(0, 0, 0, .72)')
    hole.addColorStop(1, 'rgba(0, 0, 0, 0)')
    context.fillStyle = hole
    context.fillRect(-reach, -reach, reach * 2, reach * 2)
    context.restore()
    context.globalCompositeOperation = 'source-over'

    if (readout) {
      const text = `X ${(pointer.targetX / width).toFixed(2)} · Y ${(pointer.targetY / height).toFixed(2)}`
      if (readout.textContent !== text) readout.textContent = text
    }
  }

  const tick = (now: number): void => {
    frame = window.requestAnimationFrame(tick)
    if (now - last < FRAME_MS) return
    const delta = last ? Math.min(0.1, (now - last) / 1000) : 0
    last = now
    elapsed += delta
    pointer.x += (pointer.targetX - pointer.x) * 0.07
    pointer.y += (pointer.targetY - pointer.y) * 0.07
    pointer.strength += (pointer.targetStrength - pointer.strength) * 0.05
    draw(elapsed)
  }

  const start = (): void => {
    if (reduced || frame !== null || document.hidden || !document.hasFocus()) return
    last = 0
    frame = window.requestAnimationFrame(tick)
  }
  const stop = (): void => {
    if (frame !== null) window.cancelAnimationFrame(frame)
    frame = null
  }
  const onPointer = (event: PointerEvent): void => {
    const bounds = canvas.getBoundingClientRect()
    pointer.targetX = event.clientX - bounds.left
    pointer.targetY = event.clientY - bounds.top
    pointer.targetStrength = 1
  }
  const onLeave = (): void => { pointer.targetStrength = 0 }
  const onVisibility = (): void => { if (document.hidden) stop(); else start() }
  const onResize = (): void => {
    resize()
    draw(elapsed)
  }

  resize()
  // A settled first frame between scans, so the page opens calm (and reduced motion keeps it).
  elapsed = 9
  draw(elapsed)
  window.addEventListener('resize', onResize)
  window.addEventListener('pointermove', onPointer, { passive: true })
  document.documentElement.addEventListener('pointerleave', onLeave)
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('blur', stop)
  window.addEventListener('focus', start)
  start()
  return {
    dispose() {
      stop()
      window.removeEventListener('resize', onResize)
      window.removeEventListener('pointermove', onPointer)
      document.documentElement.removeEventListener('pointerleave', onLeave)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('blur', stop)
      window.removeEventListener('focus', start)
    }
  }
}
