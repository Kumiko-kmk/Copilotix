import React from 'react'
import './appleLoader.css'

/** Vertical speed lines around the apple: x, top, length and stagger, in the 64-unit viewBox. */
const STREAKS = [
  { x: 17, y: 10, length: 14, delay: 0 },
  { x: 23, y: 4, length: 20, delay: 0.35 },
  { x: 41, y: 6, length: 18, delay: 0.15 },
  { x: 47, y: 12, length: 12, delay: 0.5 },
  { x: 29, y: 2, length: 10, delay: 0.6 },
  { x: 36, y: 0, length: 12, delay: 0.25 }
]

/**
 * The app's loading mark, taken from the apple in its icon: the apple falls without end, turning
 * as it drops, while speed lines stream up past it. With reduced motion the lines and apple hold still.
 */
export default function AppleLoader(props: { label?: string; size?: 'small' | 'large'; className?: string }): React.JSX.Element {
  const label = props.label ?? '正在加载'
  if (__COPILOTIX_LITE__) return <span className="apple-loader-label" role="status" aria-label={label}>{label}</span>
  return (
    <div className={`apple-loader is-${props.size ?? 'large'}${props.className ? ` ${props.className}` : ''}`} role="status" aria-label={label}>
      <svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">
        <g className="apple-loader-streaks">
          {STREAKS.map((streak) => (
            <line key={streak.x} x1={streak.x} x2={streak.x} y1={streak.y} y2={streak.y + streak.length} style={{ animationDelay: `-${streak.delay}s` }} />
          ))}
        </g>
        <g transform="translate(32 36) scale(2.3)">
          <g className="apple-loader-apple">
            <path className="apple-loader-fruit" d="M0 -3 C-2 -5.6 -6.2 -5 -6.2 -0.4 C-6.2 4.2 -3.2 7.2 0 6.2 C3.2 7.2 6.2 4.2 6.2 -0.4 C6.2 -5 2 -5.6 0 -3 Z" />
            <path className="apple-loader-shine" d="M-3.8 -1.6 C-3.9 -0.2 -3.4 1.2 -2.6 2" />
            <path className="apple-loader-stem" d="M0 -3 C0 -5 0.4 -6.6 1.4 -7.8" />
            <path className="apple-loader-leaf" d="M0.8 -5.6 C2.4 -8.2 5 -8.4 6.2 -7.2 C5 -5.2 3 -4.8 0.8 -5.6 Z" />
          </g>
        </g>
      </svg>
      {props.size === 'small' ? null : <span className="apple-loader-label">{label}</span>}
    </div>
  )
}
