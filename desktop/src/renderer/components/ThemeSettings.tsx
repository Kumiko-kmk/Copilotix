import React from 'react'
import { READER_FONT_SIZES, READER_LINE_HEIGHTS, THEMES, type Appearance, type ThemeDefinition } from '../theme'

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
 * 显示设置: colour themes, then the reader's text size and line height. Choices preview at once;
 * the settings page saves or reverts them with its 保存全部更改 / 放弃更改 like every other setting.
 */
export default function ThemeSettings(props: { value: Appearance; onChange(next: Appearance): void }): React.JSX.Element {
  const { value, onChange } = props
  const groups: Array<[string, string, readonly ThemeDefinition[]]> = [
    ['浅色', 'Light', THEMES.filter((theme) => !theme.dark)],
    ['深色', 'Dark', THEMES.filter((theme) => theme.dark)]
  ]
  return (
    <section className="settings-section theme-settings" aria-label="显示设置">
      <div className="theme-groups">
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
      </div>
      <div className="theme-group reader-font-setting">
        <span className="theme-group-label">阅读<small>Reader</small></span>
        <div className="reader-font-control">
          <ReaderStepper
            id="reader-font-size" label="字号" name="阅读字号" range={READER_FONT_SIZES} value={value.readerFontSize}
            decrease="A−" increase="A+" format={(size) => <>{size}<small>px</small></>}
            onChange={(readerFontSize) => onChange({ ...value, readerFontSize })}
          />
          <ReaderStepper
            id="reader-line-height" label="行间距" name="阅读行间距" range={READER_LINE_HEIGHTS} value={value.readerLineHeight}
            decrease="−" increase="+" format={(height) => <>{height.toFixed(1)}<small>倍</small></>}
            onChange={(readerLineHeight) => onChange({ ...value, readerLineHeight })}
          />
          <div className="reader-font-sample" style={{ fontSize: `${value.readerFontSize}px`, lineHeight: value.readerLineHeight }}>
            <p>
            注意力机制已成为序列建模中不可或缺的一部分，使模型能够不受距离限制地刻画依赖关系。Attention mechanisms have become an integral part of sequence modeling, allowing modeling of dependencies without regard to their distance in the input or output sequences. 在多数情况下，这类机制与循环网络结合使用；本文提出的 Transformer 则完全依赖注意力机制来建立输入与输出之间的全局依赖。</p>
            <p>Transformer 允许显著更多的并行化，在八块 P100 GPU 上仅训练十二小时，就能在翻译质量上达到新的水平。The Transformer allows for significantly more parallelization and can reach a new state of the art in translation quality after being trained for as little as twelve hours on eight P100 GPUs. 我们在后文中描述其结构，并说明自注意力相较于卷积与循环层的优势。</p>
          </div>
        </div>
      </div>
    </section>
  )
}

function ReaderStepper(props: {
  id: string
  label: string
  name: string
  range: { min: number; max: number; step: number; default: number }
  value: number
  decrease: string
  increase: string
  format(value: number): React.ReactNode
  onChange(next: number): void
}): React.JSX.Element {
  const { range, value } = props
  // Round to the step so 1.4 + 0.1 stays 1.5 instead of drifting in floating point.
  const set = (next: number): void => props.onChange(Math.min(range.max, Math.max(range.min, Number((Math.round(next / range.step) * range.step).toFixed(2)))))
  const isDefault = Math.abs(value - range.default) < range.step / 2
  return (
    <div className="reader-font-stepper">
      <span className="reader-font-stepper-label">{props.label}</span>
      <button type="button" aria-label={`减小${props.name}`} disabled={value <= range.min} onClick={() => set(value - range.step)}>{props.decrease}</button>
      <input id={props.id} type="range" aria-label={props.name} min={range.min} max={range.max} step={range.step} value={value}
        onChange={(event) => set(Number(event.target.value))} />
      <button type="button" aria-label={`增大${props.name}`} disabled={value >= range.max} onClick={() => set(value + range.step)}>{props.increase}</button>
      <output htmlFor={props.id}>{props.format(value)}</output>
      <button type="button" className="reader-font-reset" disabled={isDefault} onClick={() => set(range.default)}>恢复默认</button>
    </div>
  )
}
