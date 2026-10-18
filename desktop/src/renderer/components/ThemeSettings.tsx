import React from 'react'
import { READER_FONT_SIZES, THEMES, type Appearance, type ThemeDefinition } from '../theme'

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

/**
 * Appearance: colour themes and the reader's text size. Choices preview at once; the settings
 * page saves or reverts them with its 保存全部更改 / 放弃更改 like every other setting.
 */
export default function ThemeSettings(props: { value: Appearance; onChange(next: Appearance): void }): React.JSX.Element {
  const { value, onChange } = props
  const groups: Array<[string, string, readonly ThemeDefinition[]]> = [
    ['浅色', 'Light', THEMES.filter((theme) => !theme.dark)],
    ['深色', 'Dark', THEMES.filter((theme) => theme.dark)]
  ]
  const setSize = (size: number): void =>
    onChange({ ...value, readerFontSize: Math.min(READER_FONT_SIZES.max, Math.max(READER_FONT_SIZES.min, size)) })
  return (
    <section className="settings-section theme-settings" aria-label="主题外观">
      {groups.map(([name, label, themes]) => (
        <div key={label} className="theme-group" role="radiogroup" aria-label={`${name}主题`}>
          <span className="theme-group-label">{name}<small>{label}</small></span>
          <div className="theme-grid">
            {themes.map((theme) => (
              <label key={theme.id} className={`theme-card${value.themeId === theme.id ? ' active' : ''}`} style={previewStyle(theme)}>
                <input
                  type="radio"
                  className="visually-hidden"
                  name="color-theme"
                  value={theme.id}
                  checked={value.themeId === theme.id}
                  onChange={() => onChange({ ...value, themeId: theme.id })}
                />
                <ThemePreview />
                <span className="theme-card-copy">
                  <span className="theme-card-heading">
                    <strong>{theme.name}</strong>
                    {value.themeId === theme.id ? <em>使用中</em> : <small>{theme.label}</small>}
                  </span>
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
        </div>
      ))}
      <div className="theme-group reader-font-setting">
        <span className="theme-group-label">字号<small>Reader</small></span>
        <div className="reader-font-control">
          <div className="reader-font-stepper">
            <button type="button" aria-label="减小阅读字号" disabled={value.readerFontSize <= READER_FONT_SIZES.min}
              onClick={() => setSize(value.readerFontSize - READER_FONT_SIZES.step)}>A−</button>
            <input
              id="reader-font-size"
              type="range"
              aria-label="阅读字号"
              min={READER_FONT_SIZES.min}
              max={READER_FONT_SIZES.max}
              step={READER_FONT_SIZES.step}
              value={value.readerFontSize}
              onChange={(event) => setSize(Number(event.target.value))}
            />
            <button type="button" aria-label="增大阅读字号" disabled={value.readerFontSize >= READER_FONT_SIZES.max}
              onClick={() => setSize(value.readerFontSize + READER_FONT_SIZES.step)}>A+</button>
            <output htmlFor="reader-font-size">{value.readerFontSize}<small>px</small></output>
            {value.readerFontSize !== READER_FONT_SIZES.default ? (
              <button type="button" className="reader-font-reset" onClick={() => setSize(READER_FONT_SIZES.default)}>恢复默认</button>
            ) : null}
          </div>
          <p className="reader-font-sample" style={{ fontSize: `${value.readerFontSize}px` }}>
            注意力机制已成为序列建模中不可或缺的一部分。Attention mechanisms allow modeling of dependencies without regard to their distance.
          </p>
        </div>
      </div>
    </section>
  )
}
