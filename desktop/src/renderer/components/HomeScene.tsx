import React from 'react'

const PAPER_SHEETS = [
  { x: '6%', y: '14%', w: 132, r: -9, depth: 1.4, delay: 0, highlight: true, clip: true },
  { x: '84%', y: '10%', w: 112, r: 7, depth: 1, delay: -6, highlight: false, clip: false },
  { x: '11%', y: '66%', w: 104, r: 6, depth: .8, delay: -11, highlight: false, clip: true },
  { x: '80%', y: '58%', w: 140, r: -5, depth: 1.6, delay: -3, highlight: true, clip: false },
  { x: '46%', y: '88%', w: 86, r: 11, depth: .6, delay: -14, highlight: false, clip: false }
] as const

const PAPER_GLYPHS = [
  { text: '译', x: '4%', y: '88%', size: 46, depth: 2.2, delay: 0 },
  { text: 'Σ', x: '34%', y: '93%', size: 40, depth: 1.8, delay: -4 },
  { text: '§', x: '27%', y: '81%', size: 34, depth: 1.2, delay: -9 },
  { text: 'Aa', x: '64%', y: '85%', size: 30, depth: 1.5, delay: -2 },
  { text: '文', x: '93%', y: '41%', size: 38, depth: 2.6, delay: -7 },
  { text: '∫', x: '3%', y: '47%', size: 42, depth: 2, delay: -12 }
] as const

/** Handwritten margin notes, kept to the outer columns so they never sit behind the hero. */
const MARGIN_NOTES = [
  { text: 'E = mc²', x: '17%', y: '7%', r: -6, depth: 1.1 },
  { text: 'p < 0.05', x: '87%', y: '50%', r: 5, depth: 1.3 },
  { text: '[12]', x: '2.5%', y: '29%', r: -3, depth: 1.7 },
  { text: '∇·F = ρ/ε₀', x: '76%', y: '95%', r: -4, depth: .9 }
] as const

/** Citation links between the floating sheets, in a 0–100 viewBox stretched over the window. */
const CITATION_LINKS = [
  'M11 33 C 4 38, 2 44, 5 49',
  'M5 52 C 6 58, 9 62, 14 67',
  'M89 26 C 95 31, 96 36, 93 41',
  'M93 45 C 91 50, 88 54, 85 59',
  'M17 84 C 24 90, 34 93, 46 90',
  'M54 91 C 60 89, 63 87, 65 86'
] as const

const CITATION_NODES = [
  { x: '11%', y: '33%' }, { x: '5%', y: '50.5%' }, { x: '14%', y: '67%' },
  { x: '89%', y: '26%' }, { x: '93%', y: '43%' }, { x: '85%', y: '59%' },
  { x: '17%', y: '84%' }, { x: '46%', y: '90%' }, { x: '65%', y: '86%' }
] as const

/** Deterministic dust motes drifting up through the lamp light. */
const DUST_MOTES = Array.from({ length: 26 }, (_, index) => {
  const seed = Math.sin(index * 91.7 + 13.1) * 10_000
  const random = (offset: number): number => {
    const value = Math.sin(seed + offset) * 10_000
    return value - Math.floor(value)
  }
  return {
    x: `${(18 + random(1) * 64).toFixed(1)}%`,
    y: `${(8 + random(2) * 70).toFixed(1)}%`,
    size: `${(1.5 + random(3) * 2.5).toFixed(1)}px`,
    duration: `${(14 + random(4) * 14).toFixed(1)}s`,
    delay: `${(-random(5) * 28).toFixed(1)}s`,
    drift: `${((random(6) - .5) * 60).toFixed(0)}px`,
    depth: (.6 + random(7) * 1.8).toFixed(2)
  }
})

function style(values: Record<string, string | number>): React.CSSProperties {
  return values as React.CSSProperties
}

/** Decorative, non-interactive paper-desk backdrop drawn behind the new-parse hero. */
export function HomeBackdrop(): React.JSX.Element {
  return (
    <div className="home-backdrop" aria-hidden="true">
      <div className="paper-ruling" />
      <div className="paper-glow" />
      <div className="paper-lamp" />
      <div className="paper-coffee-ring" style={style({ '--depth': .7 })} />

      <svg className="paper-citations" viewBox="0 0 100 100" preserveAspectRatio="none">
        {CITATION_LINKS.map((path, index) => <path key={index} d={path} style={style({ '--i': index })} />)}
      </svg>
      {CITATION_NODES.map((node, index) => (
        <i key={index} className="paper-node" style={style({ '--x': node.x, '--y': node.y, '--i': index })} />
      ))}

      {PAPER_SHEETS.map((sheet, index) => (
        <div
          key={index}
          className="paper-sheet"
          style={style({ '--x': sheet.x, '--y': sheet.y, '--w': `${sheet.w}px`, '--r': `${sheet.r}deg`, '--depth': sheet.depth, '--delay': `${sheet.delay}s` })}
        >
          <i>
            {sheet.highlight ? <b /> : null}
            {sheet.clip ? <em className="paper-clip" /> : null}
          </i>
        </div>
      ))}

      <div className="paper-sticky" style={style({ '--depth': 1.2 })}>
        <i />
      </div>
      <svg className="paper-pen" viewBox="0 0 160 16" style={style({ '--depth': 1.5 })}>
        <rect className="paper-pen-body" x="22" y="4" width="108" height="8" rx="4" />
        <rect className="paper-pen-band" x="94" y="4" width="5" height="8" />
        <path className="paper-pen-nib" d="M22 4 L4 8 L22 12 Z" />
        <path className="paper-pen-clip" d="M104 3 H140 a2 2 0 0 1 0 4 H108" />
        <rect className="paper-pen-cap" x="130" y="3.5" width="26" height="9" rx="4.5" />
      </svg>

      {MARGIN_NOTES.map((note) => (
        <span key={note.text} className="paper-note" style={style({ '--x': note.x, '--y': note.y, '--r': `${note.r}deg`, '--depth': note.depth })}>
          {note.text}
        </span>
      ))}
      {PAPER_GLYPHS.map((glyph) => (
        <span
          key={glyph.text}
          className="paper-glyph"
          style={style({ '--x': glyph.x, '--y': glyph.y, '--size': `${glyph.size}px`, '--depth': glyph.depth, '--delay': `${glyph.delay}s` })}
        >
          {glyph.text}
        </span>
      ))}
      {DUST_MOTES.map((mote, index) => (
        <i
          key={index}
          className="paper-mote"
          style={style({ '--x': mote.x, '--y': mote.y, '--s': mote.size, '--d': mote.duration, '--delay': mote.delay, '--drift': mote.drift, '--depth': mote.depth })}
        />
      ))}
      <div className="paper-vignette" />
      <div className="paper-grain" />
    </div>
  )
}

/** Upload illustration: two stacked sheets that fan out on hover and lift while dragging. */
export function UploadGlyph(): React.JSX.Element {
  return (
    <span className="upload-glyph" aria-hidden="true">
      <svg viewBox="0 0 48 48" width="48" height="48">
        <g className="upload-glyph-back">
          <rect x="11" y="7" width="24" height="31" rx="4" />
        </g>
        <g className="upload-glyph-front">
          <path d="M15 11h14l8 8v20a4 4 0 0 1-4 4H15a4 4 0 0 1-4-4V15a4 4 0 0 1 4-4Z" />
          <path className="upload-glyph-fold" d="M29 11v5a3 3 0 0 0 3 3h5" />
          <path className="upload-glyph-line" d="M17 26h14M17 31h14M17 36h8" />
        </g>
      </svg>
    </span>
  )
}
