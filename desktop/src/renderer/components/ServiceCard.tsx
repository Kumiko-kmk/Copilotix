import React from 'react'
import { CheckCircleOutlined, CloseCircleOutlined } from '@ant-design/icons'

export type ServiceState = 'missing' | 'unknown' | 'valid' | 'invalid'

/** One service per row: identity, controls and state share a line so every service fits on the page. */
export function ServiceCard(props: {
  title: string
  badge: string
  name: string
  state: ServiceState
  stateLabel: string
  label?: string
  children: React.ReactNode
  footer?: React.ReactNode
}): React.JSX.Element {
  const icon = props.state === 'valid' ? <CheckCircleOutlined /> : props.state === 'invalid' ? <CloseCircleOutlined /> : null
  return (
    <section className="service-card" data-provider={props.name} aria-label={props.label}>
      <span className="service-card-identity"><strong>{props.title}</strong><span className="service-card-badge">{props.badge}</span></span>
      <div className="service-card-body">{props.children}</div>
      <span className="service-card-summary"><span className={`credential-status status-${props.state}`}>{icon}<span>{props.stateLabel}</span></span></span>
      {props.footer ? <div className="service-card-footer">{props.footer}</div> : null}
    </section>
  )
}
