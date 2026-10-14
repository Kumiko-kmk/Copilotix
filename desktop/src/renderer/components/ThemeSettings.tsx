import React from 'react'
import { THEMES, currentTheme, onThemeChange, selectTheme, type ThemeDefinition } from '../theme'

function previewStyle(theme: ThemeDefinition): React.CSSProperties {
  const { colors } = theme
  return {
    '--t-surface': colors.surface,
    '--t-sheet': colors.sheet,
    '--t-muted-surface': colors.mutedSurface,
    '--t-border': colors.border,
    '--t-ink': colors.ink,
    '--t-muted': colors.muted,
    '--t-primary': colors.primary,
    '--t-primary-soft': colors.primarySoft,
    '--t-floor': colors.archiveFloor,
    '--t-card': colors.archiveCard,
    '--t-edge': colors.archiveEdge
  } as React.CSSProperties
}

/** A miniature of the app in the theme's own colours: heading, tabs, a sheet, the archive's cassettes. */
function ThemePreview(): React.JSX.Element {
  return (
    <span className="theme-preview" aria-hidden="true">
      <span className="theme-preview-eyebrow" />
      <span className="theme-preview-title">文 Aa</span>
      <span className="theme-preview-tabs"><i className="active" /><i /><i /></span>
      <span className="theme-preview-sheet">
        <i /><i className="marked" /><i /><b />
      </span>
      <span className="theme-preview-floor">
        {Array.from({ length: 9 }, (_, index) => <i key={index} className={index === 4 ? 'selected' : undefined} />)}
      </span>
    </span>
  )
}

/** Colour themes: applied at once and remembered on this device, apart from the saved settings. */
export default function ThemeSettings(): React.JSX.Element {
  const [active, setActive] = React.useState(() => currentTheme().id)
  React.useEffect(() => onThemeChange((theme) => setActive(theme.id)), [])
  return (
    <section className="settings-section theme-settings" aria-label="主题外观">
      <div className="theme-grid" role="radiogroup" aria-label="主题色">
        {THEMES.map((theme) => (
          <label key={theme.id} className={`theme-card${active === theme.id ? ' active' : ''}`} style={previewStyle(theme)}>
            <input
              type="radio"
              className="visually-hidden"
              name="color-theme"
              value={theme.id}
              checked={active === theme.id}
              onChange={() => selectTheme(theme.id)}
            />
            <ThemePreview />
            <span className="theme-card-copy">
              <span className="theme-card-heading">
                <strong>{theme.name}</strong>
                <small>{theme.label}</small>
                {active === theme.id ? <em>使用中</em> : null}
              </span>
              <span className="theme-card-description">{theme.description}</span>
              <span className="theme-swatches" aria-hidden="true">
                <i style={{ background: theme.colors.surface }} />
                <i style={{ background: theme.colors.sheet }} />
                <i style={{ background: theme.colors.ink }} />
                <i style={{ background: theme.colors.primary }} />
                <i style={{ background: theme.colors.archiveFloor }} />
              </span>
            </span>
          </label>
        ))}
      </div>
      <p className="theme-note">主题立即生效，并保存在这台设备上；它不属于需要保存的设置。</p>
    </section>
  )
}
