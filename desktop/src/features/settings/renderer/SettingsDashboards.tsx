import React from 'react'
import type { StorageInfo, UsageAnalytics, UsageAnalyticsDay } from '../contract/settingsSchemas'

/** Usage and storage panels of the settings page; display only. */
export function UsageDashboard(props: { analytics: UsageAnalytics | null }): React.JSX.Element {
  const days = props.analytics?.days ?? emptyAnalyticsDays(84)
  return (
    <section className="usage-dashboard" aria-label="APIKey 用量分析">
      <ActivityHeatmap days={days} />
      <TokenTrendChart days={days.slice(-30)} />
    </section>
  )
}

function ActivityHeatmap(props: { days: UsageAnalyticsDay[] }): React.JSX.Element {
  const scores = props.days.map((day) => day.documents * 8 + day.pages)
  const maximum = Math.max(1, ...scores)
  const totalDocuments = props.days.reduce((sum, day) => sum + day.documents, 0)
  const totalPages = props.days.reduce((sum, day) => sum + day.pages, 0)
  return (
    <article className="usage-panel activity-panel">
      <header className="usage-panel-header">
        <span><strong>活动热力</strong><small>最近 12 周</small></span>
        <span className="usage-panel-total">共计 {totalPages} 页</span>
      </header>
      <div className="activity-heatmap" role="img" aria-label={`最近十二週上傳 ${totalDocuments} 份文檔，共 ${totalPages} 頁`}>
        {props.days.map((day, index) => {
          const score = scores[index] ?? 0
          const level = score === 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((score / maximum) * 4)))
          return <span key={day.date} className={`activity-cell level-${level}`} />
        })}
      </div>
      <footer className="activity-legend"><span>少</span>{[0, 1, 2, 3, 4].map((level) => <i key={level} className={`activity-cell level-${level}`} />)}<span>多</span></footer>
    </article>
  )
}

function TokenTrendChart(props: { days: UsageAnalyticsDay[] }): React.JSX.Element {
  const width = 480
  const height = 150
  const insetX = 18
  const insetTop = 16
  const insetBottom = 24
  const values = props.days.flatMap((day) => [day.deepseekTokens, day.qwenTokens, day.codexTokens ?? 0])
  const maximum = Math.max(1, ...values)
  const points = (key: 'deepseekTokens' | 'qwenTokens' | 'codexTokens'): string => props.days.map((day, index) => {
    const x = insetX + (index / Math.max(1, props.days.length - 1)) * (width - insetX * 2)
    const y = insetTop + (1 - (day[key] ?? 0) / maximum) * (height - insetTop - insetBottom)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  const deepseekTotal = props.days.reduce((sum, day) => sum + day.deepseekTokens, 0)
  const codexTotal = props.days.reduce((sum, day) => sum + (day.codexTokens ?? 0), 0)
  const qwenTotal = props.days.reduce((sum, day) => sum + day.qwenTokens, 0)
  return (
    <article className="usage-panel token-panel">
      <header className="usage-panel-header">
        <span><strong>模型 Token</strong><small>最近 30 天</small></span>
        <span className="token-legend"><i className="deepseek" />DeepSeek {compactNumber(deepseekTotal)}<i className="qwen" />Qwen {compactNumber(qwenTotal)}<i className="codex" />Codex {compactNumber(codexTotal)}</span>
      </header>
      <svg className="token-trend-chart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`DeepSeek ${deepseekTotal} Token，Qwen ${qwenTotal} Token`}>
        {[0, 0.5, 1].map((ratio) => <line key={ratio} x1={insetX} x2={width - insetX} y1={insetTop + ratio * (height - insetTop - insetBottom)} y2={insetTop + ratio * (height - insetTop - insetBottom)} className="token-grid-line" />)}
        <polyline points={points('deepseekTokens')} className="token-line deepseek" />
        <polyline points={points('qwenTokens')} className="token-line qwen" />
        <polyline points={points('codexTokens')} className="token-line codex" />
      </svg>
    </article>
  )
}

function emptyAnalyticsDays(count: number): UsageAnalyticsDay[] {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  date.setDate(date.getDate() - count + 1)
  return Array.from({ length: count }, () => {
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    date.setDate(date.getDate() + 1)
    return { date: key, documents: 0, pages: 0, deepseekTokens: 0, qwenTokens: 0 }
  })
}

function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`
  return String(value)
}

const STORAGE_CATEGORY_DETAILS: Record<StorageInfo['categories'][number]['kind'], { label: string; color: string }> = {
  source: { label: '源文档', color: '#5b58d6' },
  image: { label: '图片资源', color: '#4a9d84' },
  translation: { label: '翻译结果', color: '#d39b35' },
  other: { label: '其他文件', color: '#b7ab98' }
}

export function StorageMetric(props: { icon: React.ReactNode; label: string; value: string }): React.JSX.Element {
  return <div className="storage-metric"><span className="storage-metric-icon" aria-hidden="true">{props.icon}</span><span>{props.label}</span><strong>{props.value}</strong></div>
}

export function StorageComposition({ info }: { info: StorageInfo | null }): React.JSX.Element {
  const categories = info?.categories ?? []
  const total = info?.totalBytes ?? 0
  let position = 0
  const stops = categories.filter((category) => category.bytes > 0).map((category) => {
    const start = position
    position += total > 0 ? (category.bytes / total) * 100 : 0
    return `${STORAGE_CATEGORY_DETAILS[category.kind].color} ${start}% ${position}%`
  })
  const background = stops.length > 0 ? `conic-gradient(${stops.join(', ')})` : 'var(--border)'
  return (
    <section className="storage-insight-panel" aria-label="存储构成">
      <div className="storage-insight-heading"><strong>存储构成</strong><small>按实际文件类型统计</small></div>
      <div className="storage-composition-body">
        <div className="storage-donut" role="img" aria-label={`存储构成，总计 ${formatBytes(total)}`} style={{ background }}>
          <div><strong>{formatBytes(total)}</strong><span>总计</span></div>
        </div>
        <div className="storage-category-list">
          {(categories.length > 0 ? categories : Object.keys(STORAGE_CATEGORY_DETAILS).map((kind) => ({ kind: kind as keyof typeof STORAGE_CATEGORY_DETAILS, fileCount: 0, bytes: 0 }))).map((category) => {
            const details = STORAGE_CATEGORY_DETAILS[category.kind]
            return <div className="storage-category-row" key={category.kind}><i style={{ background: details.color }} /><span>{details.label}</span><strong>{formatBytes(category.bytes)}</strong></div>
          })}
        </div>
      </div>
    </section>
  )
}

export function StorageGrowth({ info }: { info: StorageInfo | null }): React.JSX.Element {
  const growth = info?.growth ?? []
  const maximum = Math.max(1, ...growth.map((point) => point.totalBytes))
  const points = growth.map((point, index) => {
    const x = growth.length <= 1 ? 20 : 20 + (index / (growth.length - 1)) * 480
    const y = 132 - (point.totalBytes / maximum) * 104
    return `${x},${y}`
  }).join(' ')
  return (
    <section className="storage-insight-panel" aria-label="近期存储增长">
      <div className="storage-insight-heading"><strong>近期存储增长</strong><small>近 14 日 · 按修改时间估算</small></div>
      <svg className="storage-growth-chart" role="img" aria-label="近 14 日存储增长曲线" viewBox="0 0 520 160" preserveAspectRatio="none">
        {[28, 80, 132].map((y) => <line className="storage-growth-grid" key={y} x1="20" x2="500" y1={y} y2={y} />)}
        {points ? <><polyline className="storage-growth-area" points={`20,132 ${points} 500,132`} /><polyline className="storage-growth-line" points={points} /></> : null}
      </svg>
      <div className="storage-growth-footer"><span>{growth[0]?.date.slice(5).replace('-', '/') ?? '—'}</span><strong>{formatBytes(growth.at(-1)?.totalBytes ?? 0)}</strong><span>{growth.at(-1)?.date.slice(5).replace('-', '/') ?? '—'}</span></div>
    </section>
  )
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[unit]}`
}
