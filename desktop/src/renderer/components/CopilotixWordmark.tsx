import React from 'react'
import { onHomeWave, requestHomeWave } from '../homeWave'

const WORDMARK_GLYPHS = [
  ['..#####', '.######', '###....', '##.....', '##.....', '##.....', '##.....', '###....', '.######', '..#####'],
  ['..####..', '.##..##.', '##....##', '##....##', '##....##', '##....##', '##....##', '##....##', '.##..##.', '..####..'],
  ['######..', '##...##.', '##....##', '##....##', '##...##.', '######..', '##......', '##......', '##......', '##......'],
  ['########', '.######.', '...##...', '...##...', '...##...', '...##...', '...##...', '...##...', '.######.', '########'],
  ['##......', '##......', '##......', '##......', '##......', '##......', '##......', '##......', '########', '########'],
  ['..####..', '.##..##.', '##....##', '##....##', '##....##', '##....##', '##....##', '##....##', '.##..##.', '..####..'],
  ['########', '.######.', '...##...', '...##...', '...##...', '...##...', '...##...', '...##...', '...##...', '...##...'],
  ['########', '.######.', '...##...', '...##...', '...##...', '...##...', '...##...', '...##...', '.######.', '########'],
  ['##....##', '##....##', '.##..##.', '..####..', '...##...', '...##...', '..####..', '.##..##.', '##....##', '##....##']
] as const

const WORDMARK_LETTERS = 'COPILOTIX'
const ROW_COUNT = 10
const LETTER_COUNT = WORDMARK_LETTERS.length
// ASCII only: every cell must stay one monospace column wide while scrambling.
const SCRAMBLE_POOL = '#%&*+=<>/\\|$@?ABDEFGHJKMNQRSUVWYZ0123456789'

/** Final text of each letter segment, indexed [row][letter]. */
const SEGMENTS: string[][] = Array.from({ length: ROW_COUNT }, (_, row) => WORDMARK_GLYPHS.map((glyph, index) =>
  glyph[row]!.replaceAll('#', WORDMARK_LETTERS[index]!).replaceAll('.', ' ')))

function scramble(text: string): string {
  return text.replace(/\S/gu, () => SCRAMBLE_POOL[Math.floor(Math.random() * SCRAMBLE_POOL.length)]!)
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

/** Letter n starts decoding n × 105 ms in: the left-to-right sweep used without a backdrop. */
const SWEEP = Array.from({ length: LETTER_COUNT }, (_, letter) => letter * 105)

/**
 * ASCII-art wordmark. Each letter is "decoded" from random glyphs, like a line being translated,
 * exactly when a decryption wave of the home backdrop crosses it (homeWave.ts); clicking the
 * wordmark sends a wave from the click. Hovering a letter lifts it and its neighbours.
 */
export default function CopilotixWordmark(): React.JSX.Element {
  const [hot, setHot] = React.useState<number | null>(null)
  const cells = React.useRef<Array<HTMLElement | null>>([])
  const frame = React.useRef(0)

  /** Decodes letter n from delays[n] ms on; letters already scrambling keep scrambling until then. */
  const decode = React.useCallback((delays: readonly number[]) => {
    if (typeof window.requestAnimationFrame !== 'function' || prefersReducedMotion()) return
    window.cancelAnimationFrame(frame.current)
    const start = performance.now()
    let lastScramble = -Infinity
    const tick = (now: number): void => {
      const elapsed = now - start
      const reshuffle = elapsed - lastScramble >= 55
      if (reshuffle) lastScramble = elapsed
      let pending = false
      for (let row = 0; row < ROW_COUNT; row += 1) {
        for (let letter = 0; letter < LETTER_COUNT; letter += 1) {
          const element = cells.current[row * LETTER_COUNT + letter]
          if (!element) continue
          const final = SEGMENTS[row]![letter]!
          const begin = delays[letter]!
          if (elapsed >= begin + 180 + row * 16) {
            if (element.dataset.state === 'scramble') {
              element.textContent = final
              element.dataset.state = 'settled'
            }
          } else {
            pending = true
            if (elapsed < begin && element.dataset.state !== 'scramble') continue
            element.dataset.state = 'scramble'
            if (reshuffle) element.textContent = scramble(final)
          }
        }
      }
      if (pending) frame.current = window.requestAnimationFrame(tick)
    }
    tick(start)
  }, [])

  React.useLayoutEffect(() => {
    const motion = typeof window.requestAnimationFrame === 'function' && !prefersReducedMotion()
    // Scrambled before the first paint; the backdrop's opening wave settles the letters.
    if (motion) {
      cells.current.forEach((element, index) => {
        if (!element) return
        element.dataset.state = 'scramble'
        element.textContent = scramble(SEGMENTS[Math.floor(index / LETTER_COUNT)]![index % LETTER_COUNT]!)
      })
    }
    let waved = false
    const stopWaves = onHomeWave((wave) => {
      waved = true
      const elapsed = performance.now() - wave.start
      decode(Array.from({ length: LETTER_COUNT }, (_, letter) => {
        const bounds = cells.current[4 * LETTER_COUNT + letter]?.getBoundingClientRect()
        if (!bounds) return 0
        const distance = Math.hypot(bounds.left + bounds.width / 2 - wave.x, bounds.top + bounds.height / 2 - wave.y)
        return Math.max(0, distance / wave.speed - elapsed)
      }))
    })
    // Without a backdrop (or under reduced motion) the letters sweep on their own.
    const fallback = motion ? window.setTimeout(() => { if (!waved) decode(SWEEP) }, 200) : 0
    return () => {
      stopWaves()
      window.clearTimeout(fallback)
      window.cancelAnimationFrame?.(frame.current)
      cells.current.forEach((element, index) => {
        if (!element) return
        element.textContent = SEGMENTS[Math.floor(index / LETTER_COUNT)]![index % LETTER_COUNT]!
        delete element.dataset.state
      })
    }
  }, [decode])

  return (
    <div
      className="copilotix-wordmark"
      role="img"
      aria-label="COPILOTIX"
      onPointerLeave={() => setHot(null)}
      onClick={(event) => { if (!requestHomeWave(event.clientX, event.clientY)) decode(SWEEP) }}
    >
      {SEGMENTS.map((segments, row) => (
        <span aria-hidden="true" key={row} style={{ '--row': row } as React.CSSProperties}>
          {segments.map((text, letter) => {
            const distance = hot === null ? Infinity : Math.abs(hot - letter)
            const className = distance === 0 ? 'is-hot' : distance === 1 ? 'is-near' : undefined
            return (
              <React.Fragment key={letter}>
                {letter === 0 ? null : letter === 1 ? '   ' : '  '}
                <i
                  ref={(element) => { cells.current[row * LETTER_COUNT + letter] = element }}
                  className={className}
                  style={{ '--l': letter } as React.CSSProperties}
                  onPointerEnter={() => setHot(letter)}
                >
                  {text}
                </i>
              </React.Fragment>
            )
          })}
        </span>
      ))}
    </div>
  )
}
