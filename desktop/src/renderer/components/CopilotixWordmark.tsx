import React from 'react'

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

/**
 * ASCII-art wordmark. On mount (and on click) each letter is "decoded" from random
 * glyphs, like a line being translated; hovering a letter lifts it and its neighbours.
 */
export default function CopilotixWordmark(): React.JSX.Element {
  const [hot, setHot] = React.useState<number | null>(null)
  const cells = React.useRef<Array<HTMLElement | null>>([])
  const frame = React.useRef(0)

  const decode = React.useCallback(() => {
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
          if (elapsed >= 180 + letter * 105 + row * 16) {
            if (element.dataset.state === 'scramble') {
              element.textContent = final
              element.dataset.state = 'settled'
            }
          } else {
            pending = true
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
    decode()
    return () => {
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
      title="点击重播"
      onPointerLeave={() => setHot(null)}
      onClick={decode}
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
