import React from 'react'

/** Page heading in the archive (文库) language: eyebrow path, heavy title, one muted line. */
export default function PageBrand(props: {
  eyebrow: string
  title: string
  meta?: React.ReactNode
  className?: string
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <header className={`page-header page-brand${props.className ? ` ${props.className}` : ''}`}>
      <div className="page-brand-copy">
        <span className="eyebrow">{props.eyebrow}</span>
        <h1>{props.title}</h1>
        {props.meta ? <p>{props.meta}</p> : null}
      </div>
      {props.children}
    </header>
  )
}

/** The archive's ink rule with its square marker. */
export function ArchiveRule(props: { className?: string }): React.JSX.Element {
  return <div className={`archive-rule${props.className ? ` ${props.className}` : ''}`} aria-hidden="true"><i /></div>
}
