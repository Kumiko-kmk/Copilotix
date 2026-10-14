/**
 * Colour themes. Each theme is a paper-and-ink palette written onto :root as the app's colour
 * tokens; styles.css, the antd provider, canvas backdrops and the archive's 3D scene all read
 * those tokens, so a theme applies everywhere at once. Values stay plain hex because canvas and
 * three.js parse them directly. The choice is a per-device preference kept in localStorage
 * (like the reader layout), applied before the first render.
 */
export interface ThemeColors {
  /** Page and window paper. */
  surface: string
  /** Raised sheets: cards, menus, dialogs. */
  sheet: string
  /** Recessed or hovered surfaces. */
  mutedSurface: string
  border: string
  /** Running text. */
  text: string
  /** Headings, ink rules and primary buttons. */
  ink: string
  muted: string
  /** The one accent: selection, focus, links, scans. */
  primary: string
  primarySoft: string
  /** The library's 3D floor, cards and index inlays. */
  archiveFloor: string
  archiveCard: string
  archiveEdge: string
  archiveIndex: string
  /** The diffuser seen through each frosted cassette. */
  archiveTray: string
}

export interface ThemeDefinition {
  id: string
  name: string
  /** Latin name, set as the eyebrow. */
  label: string
  description: string
  colors: ThemeColors
}

export const THEMES: readonly ThemeDefinition[] = [
  {
    id: 'archive', name: '档案纸', label: 'Archive paper', description: '暖白纸面、墨色字、靛紫标记，Copilotix 的原色。',
    colors: {
      surface: '#f7f2e8', sheet: '#fffdf8', mutedSurface: '#efe8dc', border: '#dcd4c7', text: '#27231e', ink: '#2f2a24', muted: '#7d7569',
      primary: '#5b58d6', primarySoft: '#ecebfb', archiveFloor: '#dccdbb', archiveCard: '#fff7ed', archiveEdge: '#fff5e9', archiveIndex: '#e4d6c5', archiveTray: '#806447'
    }
  },
  {
    id: 'celadon', name: '青瓷', label: 'Celadon', description: '冷调瓷白配松烟墨，釉青作标记，安静耐看。',
    colors: {
      surface: '#eef1ec', sheet: '#fafcf9', mutedSurface: '#e1e7e1', border: '#cbd5cd', text: '#1f2826', ink: '#24302d', muted: '#6b7873',
      primary: '#2f7d6d', primarySoft: '#dcece6', archiveFloor: '#c9d4cc', archiveCard: '#f6faf6', archiveEdge: '#f2f7f3', archiveIndex: '#d3ddd6', archiveTray: '#5d7a6d'
    }
  },
  {
    id: 'cinnabar', name: '朱砂', label: 'Cinnabar', description: '宣纸底、焦墨字、朱砂印泥红，像钤了印的旧书页。',
    colors: {
      surface: '#f5efe4', sheet: '#fffcf6', mutedSurface: '#ece3d4', border: '#dccfbd', text: '#2a2320', ink: '#2b211d', muted: '#7f7062',
      primary: '#b8432f', primarySoft: '#f6e3db', archiveFloor: '#dccab3', archiveCard: '#fff6ec', archiveEdge: '#fdf2e6', archiveIndex: '#e6d4c0', archiveTray: '#86553e'
    }
  },
  {
    id: 'aizome', name: '蓝染', label: 'Aizome', description: '靛蓝染布的深蓝与灰白，冷静、专注，适合长时间阅读。',
    colors: {
      surface: '#eef0f3', sheet: '#fafbfd', mutedSurface: '#e1e5ec', border: '#cdd3de', text: '#1d2230', ink: '#1f2638', muted: '#6c7386',
      primary: '#2c4f96', primarySoft: '#dfe6f4', archiveFloor: '#c8cfdc', archiveCard: '#f7f9fc', archiveEdge: '#f2f5fa', archiveIndex: '#d2d9e6', archiveTray: '#5a6886'
    }
  },
  {
    id: 'amber', name: '琥珀', label: 'Amber library', description: '老图书馆的灯下纸色，咖啡墨与琥珀金，温暖而沉稳。',
    colors: {
      surface: '#f3ebdd', sheet: '#fdf8ef', mutedSurface: '#e9dfcc', border: '#d8c9b0', text: '#2e2419', ink: '#33281c', muted: '#80705c',
      primary: '#a8641a', primarySoft: '#f3e3c8', archiveFloor: '#d6c2a2', archiveCard: '#fcf3e4', archiveEdge: '#faefdc', archiveIndex: '#e2d0b2', archiveTray: '#7f5a31'
    }
  },
  {
    id: 'graphite', name: '石墨', label: 'Graphite', description: '中性灰白与石墨黑，一点信号橙，像一台精密仪器。',
    colors: {
      surface: '#f2f2f0', sheet: '#fcfcfb', mutedSurface: '#e6e6e3', border: '#d2d2ce', text: '#1d1d1f', ink: '#1f1f21', muted: '#73736f',
      primary: '#e5532a', primarySoft: '#fbe4dc', archiveFloor: '#d0d0cc', archiveCard: '#fafaf8', archiveEdge: '#f5f5f3', archiveIndex: '#dadad6', archiveTray: '#6c6c68'
    }
  }
]

export const DEFAULT_THEME = THEMES[0]!
const STORAGE_KEY = 'copilotix.theme.v1'
const listeners = new Set<(theme: ThemeDefinition) => void>()
let current: ThemeDefinition = DEFAULT_THEME

const TOKENS: ReadonlyArray<[string, keyof ThemeColors]> = [
  ['--app-bg', 'surface'], ['--surface', 'surface'], ['--sheet', 'sheet'], ['--muted-surface', 'mutedSurface'],
  ['--border', 'border'], ['--text', 'text'], ['--ink', 'ink'], ['--muted', 'muted'],
  ['--primary', 'primary'], ['--primary-soft', 'primarySoft'],
  ['--theme-archive-floor', 'archiveFloor'], ['--theme-archive-card', 'archiveCard'], ['--theme-archive-edge', 'archiveEdge'], ['--theme-archive-index', 'archiveIndex'], ['--theme-archive-tray', 'archiveTray']
]

export function findTheme(id: string | null | undefined): ThemeDefinition {
  return THEMES.find((theme) => theme.id === id) ?? DEFAULT_THEME
}

function storedThemeId(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

export function currentTheme(): ThemeDefinition {
  return current
}

/** Writes the theme's tokens onto :root; the stylesheet's own values are the default theme. */
export function applyTheme(theme: ThemeDefinition, root: HTMLElement = document.documentElement): void {
  current = theme
  root.dataset.colorTheme = theme.id
  for (const [property, key] of TOKENS) root.style.setProperty(property, theme.colors[key])
  for (const listener of listeners) listener(theme)
}

export function selectTheme(id: string): ThemeDefinition {
  const theme = findTheme(id)
  try {
    window.localStorage.setItem(STORAGE_KEY, theme.id)
  } catch {
    // The choice still applies for this session.
  }
  applyTheme(theme)
  return theme
}

export function restoreTheme(): ThemeDefinition {
  const theme = findTheme(storedThemeId())
  applyTheme(theme)
  return theme
}

export function onThemeChange(listener: (theme: ThemeDefinition) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** "#rrggbb" to "r, g, b" for canvas rgba() strings. */
export function rgbChannels(hex: string): string {
  const value = /^#?([0-9a-f]{6})$/iu.exec(hex.trim())?.[1]
  if (!value) return '0, 0, 0'
  const number = Number.parseInt(value, 16)
  return `${number >> 16}, ${(number >> 8) & 255}, ${number & 255}`
}

/** Mixes two "#rrggbb" colours; amount is the share of the second. */
export function mixHex(from: string, to: string, amount: number): string {
  const a = rgbChannels(from).split(',').map(Number)
  const b = rgbChannels(to).split(',').map(Number)
  return `#${a.map((channel, index) => Math.round(channel + (b[index]! - channel) * amount).toString(16).padStart(2, '0')).join('')}`
}
