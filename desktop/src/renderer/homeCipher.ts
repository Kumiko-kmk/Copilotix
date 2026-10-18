import { emitHomeWave, handleHomeWaveRequests } from './homeWave'
import { rgbChannels } from './theme'

/**
 * Home backdrop: a cipher field. Faint monospace glyphs sit on the wordmark's own character grid
 * (same font, size, columns and rows), so the title reads as the brightest part of the field.
 * Decryption waves expand once from their origin and fade at the window edge: one when the page
 * opens, one where the user clicks, and otherwise only rarely. A front scrambles the glyphs it
 * crosses in the accent and leaves library papers behind it — original or translated titles —
 * which fade back into the field after a few seconds. The wordmark decodes in step with
 * every front (homeWave.ts); a new wave first fades out the titles the last one left. Between
 * waves the field keeps flickering so it never reads as a still image. Static under reduced
 * motion; paused while hidden or unfocused.
 */
export interface CipherTitle {
  /** Original and, once read, translated title. */
  texts: readonly string[]
}

export interface CipherField {
  setTitles(titles: readonly CipherTitle[]): void
  dispose(): void
}

const IDLE_POOL = 'abcdefghijklmnopqrstuvwxyz0123456789+-=<>/\\|:;.'
/** The wordmark's own scramble glyphs. */
const SCRAMBLE_POOL = '#%&*+=<>/\\|$@?ABDEFGHJKMNQRSUVWYZ0123456789'
const FRAME_MS = 1000 / 30
const WAVE_SPEED = 520
const AUTO_WAVE_SECONDS = 75
const AUTO_WAVE_SPREAD = 45
const REVEAL_SECONDS = 7
const REVEAL_FADE = 1.4
/** A new wave clears the titles still showing from the last one this quickly. */
const CLEAR_FADE = 0.45
/** The idle field keeps changing: every tick some glyphs change, appear or vanish, and one may spark. */
const FLICKER_SECONDS = 0.08
const FLICKER_SHARE = 0.006
const SPARK_CHANCE = 0.22
/** Foreground blocks the field keeps clear of. */
const HERO_SELECTORS = '.copilotix-wordmark, .new-parse-heading, .upload-entry, .tutorial-entry, .token-required, .import-options, .selected-files'
/** Clicks on these act on the page, not the backdrop. */
const INTERACTIVE = 'button, a, input, label, textarea, select, [role="button"], .upload-entry, .copilotix-wordmark, .ant-alert, .selected-files, .import-options'
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u

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

function smooth(edge0: number, edge1: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

const pick = (pool: string): string => pool[Math.floor(Math.random() * pool.length)]!

interface Wave { x: number; y: number; start: number; speed: number; reach: number }

export function startCipherField(
  canvas: HTMLCanvasElement,
  page: HTMLElement,
  wordmark: HTMLElement | null,
  initialTitles: readonly CipherTitle[] = []
): CipherField | null {
  const context = typeof CanvasRenderingContext2D === 'undefined' ? null : canvas.getContext('2d')
  const base = document.createElement('canvas')
  const baseContext = context ? base.getContext('2d') : null
  if (!context || !baseContext) return null
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

  let width = 0
  let height = 0
  let left = 0
  let top = 0
  let cellWidth = 8
  let rowHeight = 12
  let originX = 0
  let originY = 0
  let columns = 0
  let rows = 0
  let font = ''
  /** Theme ink and accent as "r, g, b", read from :root on every measure. */
  let ink = '47, 42, 36'
  let accent = '91, 88, 214'
  let glyph = new Uint8Array(0)
  let shade = new Float32Array(0)
  /** Each cell's glyph strength when shown, and its chance of being shown. */
  let strength = new Float32Array(0)
  let density = new Float32Array(0)
  let revealFade = new Float32Array(0)
  let mask = new Float32Array(0)
  let flash = new Float32Array(0)
  let revealUntil = new Float32Array(0)
  /** 1 starts a double-width character, 2 is the cell it also covers. */
  let revealWide = new Uint8Array(0)
  let pendingWide = new Uint8Array(0)
  let reveal: Array<string | null> = []
  let pending: Array<string | null> = []
  let titles = initialTitles
  const waves: Wave[] = []
  let elapsed = 0
  let nextAuto = AUTO_WAVE_SECONDS
  let nextFlicker = 0
  let dirty = true
  let frame: number | null = null
  let last = 0

  const cellX = (column: number): number => originX + column * cellWidth
  const cellY = (row: number): number => originY + row * rowHeight

  const drawBaseCell = (index: number): void => {
    const column = index % columns
    const row = Math.floor(index / columns)
    const alpha = shade[index]!
    if (alpha < 0.005) return
    baseContext.fillStyle = `rgba(${ink}, ${alpha.toFixed(3)})`
    baseContext.fillText(IDLE_POOL[glyph[index]!]!, cellX(column) + cellWidth / 2, cellY(row) + rowHeight / 2)
  }

  const paintBase = (): void => {
    baseContext.clearRect(0, 0, width, height)
    baseContext.font = font
    baseContext.textAlign = 'center'
    baseContext.textBaseline = 'middle'
    for (let index = 0; index < columns * rows; index++) drawBaseCell(index)
    dirty = true
  }

  const measure = (): void => {
    const bounds = canvas.getBoundingClientRect()
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5)
    width = Math.max(1, bounds.width)
    height = Math.max(1, bounds.height)
    left = bounds.left
    top = bounds.top
    for (const [target, target2d] of [[canvas, context], [base, baseContext]] as const) {
      target.width = Math.round(width * ratio)
      target.height = Math.round(height * ratio)
      target2d.setTransform(ratio, 0, 0, ratio, 0, 0)
    }
    const tokens = getComputedStyle(document.documentElement)
    ink = rgbChannels(tokens.getPropertyValue('--ink'))
    accent = rgbChannels(tokens.getPropertyValue('--primary'))
    // The wordmark's grid: its rows are equal-length monospace lines, ten of them.
    const style = wordmark ? getComputedStyle(wordmark) : null
    const fontSize = style ? parseFloat(style.fontSize) || 14 : 14
    font = `400 ${fontSize}px ${style?.fontFamily || 'Consolas, monospace'}`
    const mark = wordmark?.getBoundingClientRect()
    const line = wordmark?.querySelector('span')?.textContent?.length ?? 0
    cellWidth = mark && line ? mark.width / line : fontSize * 0.6
    rowHeight = mark && mark.height ? mark.height / 10 : fontSize * 0.9
    if (cellWidth < 4 || rowHeight < 6) { cellWidth = Math.max(4, fontSize * 0.6); rowHeight = Math.max(6, fontSize * 0.9) }
    const anchorX = mark ? mark.left - left : 0
    const anchorY = mark ? mark.top - top : 0
    originX = anchorX - Math.ceil(anchorX / cellWidth) * cellWidth
    originY = anchorY - Math.ceil(anchorY / rowHeight) * rowHeight
    columns = Math.ceil((width - originX) / cellWidth)
    rows = Math.ceil((height - originY) / rowHeight)
    const count = columns * rows
    glyph = new Uint8Array(count).map(() => Math.floor(Math.random() * IDLE_POOL.length))
    shade = new Float32Array(count)
    strength = new Float32Array(count)
    density = new Float32Array(count)
    revealFade = new Float32Array(count)
    mask = new Float32Array(count)
    flash = new Float32Array(count)
    revealUntil = new Float32Array(count)
    revealWide = new Uint8Array(count)
    pendingWide = new Uint8Array(count)
    reveal = new Array<string | null>(count).fill(null)
    pending = new Array<string | null>(count).fill(null)
    waves.length = 0
    const blocks = [...page.querySelectorAll<HTMLElement>(HERO_SELECTORS)]
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .map((rect) => ({ x0: rect.left - left, y0: rect.top - top, x1: rect.right - left, y1: rect.bottom - top }))
    const halo = cellWidth * 4
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const index = row * columns + column
        const x = cellX(column) + cellWidth / 2
        const y = cellY(row) + rowHeight / 2
        let nearest = Infinity
        for (const block of blocks) {
          const dx = Math.max(block.x0 - x, 0, x - block.x1)
          const dy = Math.max(block.y0 - y, 0, y - block.y1)
          nearest = Math.min(nearest, Math.hypot(dx, dy))
        }
        // Clear of the foreground by a cell, softer near it, and calmer toward the middle.
        const dx = (x - width / 2) / (width * 0.5)
        const dy = (y - height / 2) / (height * 0.5)
        const calm = 0.45 + 0.55 * smooth(0.2, 1.1, Math.hypot(dx, dy))
        mask[index] = nearest < cellWidth ? 0 : (0.35 + 0.65 * smooth(cellWidth, halo, nearest)) * calm
        // Rows are as tight as the wordmark's, so only clusters of cells carry a glyph.
        density[index] = 0.16 + 0.44 * smooth(0.25, 0.8, valueNoise(x / 230 + 7, y / 230 + 3))
        strength[index] = (0.06 + 0.08 * valueNoise(x / 90, y / 90)) * mask[index]!
        shade[index] = Math.random() < density[index]! ? strength[index]! : 0
      }
    }
    paintBase()
  }

  const placeTitles = (): void => {
    pending.fill(null)
    pendingWide.fill(0)
    if (!titles.length) return
    const order = titles.slice().sort(() => Math.random() - 0.5)
    const wanted = Math.min(order.length, 3 + Math.floor(rows / 12))
    const maxLength = Math.max(8, Math.min(columns - 8, 58))
    let placed = 0
    for (const title of order) {
      if (placed >= wanted) break
      const text = title.texts[Math.floor(Math.random() * title.texts.length)] ?? ''
      const cells: Array<[string, boolean]> = []
      for (const char of text) {
        const wide = WIDE.test(char)
        if (cells.length + (wide ? 2 : 1) > maxLength - 1) { cells.push(['…', false]); break }
        cells.push([char, wide])
        if (wide) cells.push(['', false])
      }
      for (let attempt = 0; attempt < 40; attempt++) {
        const row = 1 + Math.floor(Math.random() * Math.max(1, rows - 2))
        const column = 3 + Math.floor(Math.random() * Math.max(1, columns - cells.length - 6))
        if (column + cells.length > columns - 3) continue
        let free = true
        for (let offset = -1; offset <= cells.length && free; offset++) {
          for (const r of [row - 1, row, row + 1]) {
            if (r < 0 || r >= rows) continue
            const index = r * columns + column + offset
            if (r === row && offset >= 0 && offset < cells.length && (mask[index] ?? 0) < 0.5) free = false
            if (pending[index] !== null && pending[index] !== undefined) free = false
          }
        }
        if (!free) continue
        cells.forEach(([char, wide], offset) => {
          const index = row * columns + column + offset
          pending[index] = char
          pendingWide[index] = wide ? 1 : char === '' ? 2 : 0
        })
        placed++
        break
      }
    }
  }

  const startWave = (x: number, y: number): void => {
    if (reduced) return
    const speed = WAVE_SPEED * Math.min(1.4, Math.max(0.7, width / 1440))
    const reach = Math.max(Math.hypot(x, y), Math.hypot(width - x, y), Math.hypot(x, height - y), Math.hypot(width - x, height - y))
    // Titles still showing from the previous wave fade out at once instead of piling up.
    for (let index = 0; index < reveal.length; index++) {
      if (reveal[index] === null || revealUntil[index]! - elapsed <= CLEAR_FADE) continue
      const remaining = Math.min(1, (revealUntil[index]! - elapsed) / revealFade[index]!)
      revealUntil[index] = elapsed + CLEAR_FADE * remaining
      revealFade[index] = CLEAR_FADE
    }
    waves.push({ x, y, start: elapsed, speed, reach })
    placeTitles()
    emitHomeWave({ x: x + left, y: y + top, start: performance.now(), speed: speed / 1000 })
    start()
  }

  const step = (dt: number): void => {
    elapsed += dt
    if (elapsed >= nextAuto) {
      nextAuto = elapsed + AUTO_WAVE_SECONDS + Math.random() * AUTO_WAVE_SPREAD
      const angle = Math.random() * Math.PI * 2
      startWave(width / 2 + Math.cos(angle) * width * 0.46, height / 2 + Math.sin(angle) * height * 0.46)
    }
    if (elapsed >= nextFlicker) {
      nextFlicker = elapsed + FLICKER_SECONDS
      baseContext.font = font
      for (let count = Math.ceil(columns * rows * FLICKER_SHARE); count > 0; count--) {
        const index = Math.floor(Math.random() * columns * rows)
        if (strength[index]! < 0.005) continue
        // Mostly a new glyph; now and then a cell appears or empties, so the field never settles.
        if (Math.random() < 0.3) shade[index] = Math.random() < density[index]! ? strength[index]! : 0
        glyph[index] = Math.floor(Math.random() * IDLE_POOL.length)
        baseContext.clearRect(cellX(index % columns), cellY(Math.floor(index / columns)), cellWidth, rowHeight)
        drawBaseCell(index)
        dirty = true
      }
      if (Math.random() < SPARK_CHANCE) {
        const index = Math.floor(Math.random() * columns * rows)
        if (mask[index]! > 0 && reveal[index] === null) flash[index] = Math.max(flash[index]!, 0.55)
      }
    }
    const band = cellWidth * 1.8
    for (let k = waves.length - 1; k >= 0; k--) if ((elapsed - waves[k]!.start) * waves[k]!.speed > waves[k]!.reach + band) waves.splice(k, 1)
    if (waves.length) {
      for (let row = 0; row < rows; row++) {
        const y = cellY(row) + rowHeight / 2
        for (let column = 0; column < columns; column++) {
          const index = row * columns + column
          if (mask[index] === 0) continue
          const x = cellX(column) + cellWidth / 2
          for (const wave of waves) {
            const distance = Math.abs(Math.hypot(x - wave.x, y - wave.y) - (elapsed - wave.start) * wave.speed)
            if (distance >= band) continue
            flash[index] = Math.max(flash[index]!, 1 - distance / band)
            const char = pending[index]
            if (char !== null && char !== undefined) {
              reveal[index] = char
              revealWide[index] = pendingWide[index]!
              revealUntil[index] = elapsed + REVEAL_SECONDS
              revealFade[index] = REVEAL_FADE
              pending[index] = null
            }
          }
        }
      }
    }
  }

  const draw = (dt: number): void => {
    let active = waves.length > 0
    // A front is a thin ring: a cell's flash is gone about 0.15 s after the front passes it.
    const decay = Math.pow(1e-9, dt)
    for (let index = 0; index < flash.length && !active; index++) if (flash[index]! > 0 || reveal[index] !== null) active = true
    if (!active && !dirty) return
    dirty = active
    context.clearRect(0, 0, width, height)
    context.drawImage(base, 0, 0, width, height)
    if (!active) return
    context.font = font
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    for (let index = 0; index < flash.length; index++) {
      const shown = reveal[index]
      if (flash[index]! <= 0 && shown === null) continue
      const column = index % columns
      const x = cellX(column)
      const y = cellY(Math.floor(index / columns))
      if (shown !== null && elapsed > revealUntil[index]!) {
        reveal[index] = null
        revealWide[index] = 0
      }
      if (revealWide[index] === 2) { flash[index] = 0; continue }
      const wide = revealWide[index] === 1 && column + 1 < columns
      context.clearRect(x, y, cellWidth * (wide ? 2 : 1), rowHeight)
      if (flash[index]! > 0.04) {
        context.fillStyle = `rgba(${accent}, ${((0.25 + 0.7 * flash[index]!) * Math.max(0.5, mask[index]!)).toFixed(3)})`
        context.fillText(pick(SCRAMBLE_POOL), x + cellWidth / 2, y + rowHeight / 2)
        flash[index] = flash[index]! * decay
      } else {
        flash[index] = 0
        const text = reveal[index]
        if (text) {
          const fade = Math.min(1, (revealUntil[index]! - elapsed) / revealFade[index]!)
          context.fillStyle = `rgba(${ink}, ${(0.82 * fade * Math.max(0.7, mask[index]!)).toFixed(3)})`
          context.fillText(text, x + (wide ? cellWidth : cellWidth / 2), y + rowHeight / 2)
        } else if (shade[index]! >= 0.005) {
          context.fillStyle = `rgba(${ink}, ${shade[index]!.toFixed(3)})`
          context.fillText(IDLE_POOL[glyph[index]!]!, x + cellWidth / 2, y + rowHeight / 2)
        }
      }
    }
  }

  const tick = (now: number): void => {
    frame = window.requestAnimationFrame(tick)
    if (now - last < FRAME_MS) return
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 1 / 30
    last = now
    step(dt)
    draw(dt)
  }

  function start(): void {
    if (reduced || frame !== null || document.hidden || !document.hasFocus()) return
    last = 0
    frame = window.requestAnimationFrame(tick)
  }
  const stop = (): void => {
    if (frame !== null) window.cancelAnimationFrame(frame)
    frame = null
  }
  let resizeFrame: number | null = null
  const remeasure = (): void => {
    if (resizeFrame !== null) return
    resizeFrame = window.requestAnimationFrame(() => {
      resizeFrame = null
      measure()
      draw(0)
    })
  }
  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || (event.target instanceof Element && event.target.closest(INTERACTIVE))) return
    startWave(event.clientX - left, event.clientY - top)
  }
  const onVisibility = (): void => { if (document.hidden) stop(); else start() }

  measure()
  draw(0)
  // The page opens with one wave from the wordmark's left edge, decoding the title as it passes.
  const mark = wordmark?.getBoundingClientRect()
  if (mark) startWave(mark.left - left - cellWidth * 2, mark.top - top + mark.height / 2)
  const stopRequests = handleHomeWaveRequests((x, y) => startWave(x - left, y - top))
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(remeasure)
  const hero = page.querySelector('.new-parse-hero')
  if (observer && hero) observer.observe(hero)
  window.addEventListener('resize', remeasure)
  page.addEventListener('pointerdown', onPointerDown)
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('blur', stop)
  window.addEventListener('focus', start)
  start()
  return {
    setTitles(next) {
      // Titles that arrive while the opening wave is still out join it.
      const late = !titles.length && next.length > 0 && waves.length > 0
      titles = next
      if (late) placeTitles()
    },
    dispose() {
      stop()
      if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame)
      stopRequests()
      observer?.disconnect()
      window.removeEventListener('resize', remeasure)
      page.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('blur', stop)
      window.removeEventListener('focus', start)
    }
  }
}
