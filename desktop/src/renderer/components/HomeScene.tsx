import React from 'react'

const PAPER_SHEETS = [
  { x: '7%', y: '16%', w: 132, r: -9, depth: 1.4, delay: 0, highlight: true },
  { x: '84%', y: '12%', w: 112, r: 7, depth: 1, delay: -6, highlight: false },
  { x: '12%', y: '68%', w: 104, r: 6, depth: .8, delay: -11, highlight: false },
  { x: '80%', y: '62%', w: 146, r: -5, depth: 1.6, delay: -3, highlight: true },
  { x: '46%', y: '86%', w: 86, r: 11, depth: .6, delay: -14, highlight: false }
] as const

const PAPER_GLYPHS = [
  { text: '译', x: '4%', y: '86%', size: 46, depth: 2.2, delay: 0 },
  { text: 'Σ', x: '34%', y: '92%', size: 40, depth: 1.8, delay: -4 },
  { text: '§', x: '28%', y: '80%', size: 34, depth: 1.2, delay: -9 },
  { text: 'Aa', x: '66%', y: '82%', size: 30, depth: 1.5, delay: -2 },
  { text: '文', x: '91%', y: '40%', size: 38, depth: 2.6, delay: -7 },
  { text: '∫', x: '4%', y: '44%', size: 42, depth: 2, delay: -12 }
] as const

/** Decorative, non-interactive paper-desk backdrop drawn behind the new-parse hero. */
export function HomeBackdrop(): React.JSX.Element {
  return (
    <div className="home-backdrop" aria-hidden="true">
      <div className="paper-glow" />
      <div className="paper-lamp" />
      {PAPER_SHEETS.map((sheet, index) => (
        <div
          key={index}
          className="paper-sheet"
          style={{ '--x': sheet.x, '--y': sheet.y, '--w': `${sheet.w}px`, '--r': `${sheet.r}deg`, '--depth': sheet.depth, '--delay': `${sheet.delay}s` } as React.CSSProperties}
        >
          <i>{sheet.highlight ? <b /> : null}</i>
        </div>
      ))}
      {PAPER_GLYPHS.map((glyph) => (
        <span
          key={glyph.text}
          className="paper-glyph"
          style={{ '--x': glyph.x, '--y': glyph.y, '--size': `${glyph.size}px`, '--depth': glyph.depth, '--delay': `${glyph.delay}s` } as React.CSSProperties}
        >
          {glyph.text}
        </span>
      ))}
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
