import React from 'react'

/**
 * Decorative, non-interactive backdrop behind the new-parse hero, in the archive (文库) language:
 * a faint drafting grid over the warm floor, framed by four crop marks.
 */
export function HomeBackdrop(): React.JSX.Element {
  return (
    <div className="home-backdrop" aria-hidden="true">
      <div className="home-grid" />
      <div className="home-floor" />
      <i className="home-crop top-left" />
      <i className="home-crop top-right" />
      <i className="home-crop bottom-left" />
      <i className="home-crop bottom-right" />
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
          <rect x="11" y="7" width="24" height="31" rx="1" />
        </g>
        <g className="upload-glyph-front">
          <path d="M14 11h15l8 8v23H14Z" />
          <path className="upload-glyph-fold" d="M29 11v8h8" />
          <path className="upload-glyph-line" d="M18 26h14M18 31h14M18 36h8" />
        </g>
      </svg>
    </span>
  )
}
