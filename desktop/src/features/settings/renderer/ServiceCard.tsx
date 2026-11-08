import React from 'react'

export type ServiceState = 'missing' | 'unknown' | 'valid' | 'invalid'

/** One service per row: name with its state on the left, controls on the right, so every service fits on the page. */
export function ServiceCard(props: {
  title: string
  name: string
  state: ServiceState
  stateLabel: string
  label?: string
  children: React.ReactNode
  footer?: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="service-card" data-provider={props.name} aria-label={props.label}>
      <span className="service-card-identity">
        <strong>{props.title}</strong>
        <span className={`credential-status status-${props.state}`}>{props.stateLabel}</span>
      </span>
      <div className="service-card-body">{props.children}</div>
      {props.footer ? <div className="service-card-footer">{props.footer}</div> : null}
    </section>
  )
}
