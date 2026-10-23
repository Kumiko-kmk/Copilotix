/**
 * Colour themes. Each theme is a paper-and-ink palette written onto :root as the app's colour
 * tokens; styles.css, the antd provider, canvas backdrops and the archive's 3D scene all read
 * those tokens, so a theme applies everywhere at once. Values stay plain hex because canvas and
 * three.js parse them directly. The choice is a per-device preference kept in localStorage
 * (like the reader layout), applied before the first render. Dark themes also switch antd to
 * its dark algorithm and keep shadows black.
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
  /** Text set on ink: primary buttons, the drag ghost label. */
  onInk: string
  muted: string
  /** The one accent: selection, focus, links, scans. */
  primary: string
  primarySoft: string
  /** The library's 3D floor, cards, index inlays and the diffuser inside each cassette. */
  archiveFloor: string
  archiveCard: string
  archiveEdge: string
  archiveIndex: string
  archiveTray: string
}

export interface ThemeDefinition {
  id: string
  name: string
  /** Latin name, set as the eyebrow. */
  label: string
  dark: boolean
  colors: ThemeColors
}

const light = (id: string, name: string, label: string, colors: Omit<ThemeColors, 'onInk'>): ThemeDefinition =>
  ({ id, name, label, dark: false, colors: { ...colors, onInk: '#ffffff' } })
const dark = (id: string, name: string, label: string, colors: Omit<ThemeColors, 'onInk'>): ThemeDefinition =>
  ({ id, name, label, dark: true, colors: { ...colors, onInk: colors.surface } })

/** Three paper themes and three night themes, each with its own accent. */
export const THEMES: readonly ThemeDefinition[] = [
  light('archive', '档案纸', 'Archive paper', {
    surface: '#f7f2e8', sheet: '#fffdf8', mutedSurface: '#efe8dc', border: '#dcd4c7', text: '#27231e', ink: '#2f2a24', muted: '#7d7569',
    primary: '#5b58d6', primarySoft: '#ecebfb', archiveFloor: '#dccdbb', archiveCard: '#fff7ed', archiveEdge: '#fff5e9', archiveIndex: '#e4d6c5', archiveTray: '#806447'
  }),
  light('celadon', '青瓷', 'Celadon', {
    surface: '#eef1ec', sheet: '#fafcf9', mutedSurface: '#e1e7e1', border: '#cbd5cd', text: '#1f2826', ink: '#24302d', muted: '#6b7873',
    primary: '#2f7d6d', primarySoft: '#dcece6', archiveFloor: '#c9d4cc', archiveCard: '#f6faf6', archiveEdge: '#f2f7f3', archiveIndex: '#d3ddd6', archiveTray: '#5d7a6d'
  }),
  light('cinnabar', '朱砂', 'Cinnabar', {
    surface: '#f5efe4', sheet: '#fffcf6', mutedSurface: '#ece3d4', border: '#dccfbd', text: '#2a2320', ink: '#2b211d', muted: '#7f7062',
    primary: '#b8432f', primarySoft: '#f6e3db', archiveFloor: '#dccab3', archiveCard: '#fff6ec', archiveEdge: '#fdf2e6', archiveIndex: '#e6d4c0', archiveTray: '#86553e'
  }),
  dark('archive-night', '夜档', 'Night archive', {
    surface: '#1b1916', sheet: '#24211d', mutedSurface: '#2c2823', border: '#3b362f', text: '#e4ddd1', ink: '#f1eadf', muted: '#999082',
    primary: '#9693f5', primarySoft: '#2b2a46', archiveFloor: '#26221d', archiveCard: '#3a352e', archiveEdge: '#4b453c', archiveIndex: '#4a4339', archiveTray: '#0f0d0b'
  }),
  dark('midnight', '深靛', 'Midnight indigo', {
    surface: '#11151d', sheet: '#191e29', mutedSurface: '#202634', border: '#30394b', text: '#d9dfec', ink: '#e9edf6', muted: '#858ea4',
    primary: '#7fa6ff', primarySoft: '#1e2a46', archiveFloor: '#192030', archiveCard: '#272f43', archiveEdge: '#353f58', archiveIndex: '#323b51', archiveTray: '#090c13'
  }),
  dark('espresso', '焦糖', 'Espresso', {
    surface: '#1a1510', sheet: '#241d16', mutedSurface: '#2c241b', border: '#3f3429', text: '#e9dece', ink: '#f4e9d7', muted: '#a29178',
    primary: '#e6a24c', primarySoft: '#3a2b17', archiveFloor: '#271f17', archiveCard: '#3a2f23', archiveEdge: '#4b3d2e', archiveIndex: '#493c2c', archiveTray: '#100c08'
  })
]

export const DEFAULT_THEME = THEMES[0]!
const STORAGE_KEY = 'copilotix.theme.v1'
const listeners = new Set<(theme: ThemeDefinition) => void>()
let current: ThemeDefinition = DEFAULT_THEME

const TOKENS: ReadonlyArray<[string, keyof ThemeColors]> = [
  ['--app-bg', 'surface'], ['--surface', 'surface'], ['--sheet', 'sheet'], ['--muted-surface', 'mutedSurface'],
  ['--border', 'border'], ['--text', 'text'], ['--ink', 'ink'], ['--on-ink', 'onInk'], ['--muted', 'muted'],
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
  // Lifted panels, shadows and the window edge differ in kind, not just colour, at night.
  root.style.setProperty('--lift', theme.dark ? 'color-mix(in srgb, #fff 5%, transparent)' : 'color-mix(in srgb, #fff 40%, transparent)')
  root.style.setProperty('--lift-strong', theme.dark ? 'color-mix(in srgb, #fff 9%, transparent)' : 'color-mix(in srgb, #fff 62%, transparent)')
  root.style.setProperty('--shadow-ink', theme.dark ? '#000000' : theme.colors.ink)
  root.style.setProperty('--shell-edge', theme.dark ? 'rgba(255, 255, 255, .08)' : 'rgba(255, 255, 255, .72)')
  root.style.setProperty('--theme-archive-card-selected', theme.dark ? mixHex(theme.colors.archiveCard, theme.colors.ink, 0.45) : '#ffffff')
  root.style.colorScheme = theme.dark ? 'dark' : 'light'
  for (const listener of listeners) listener(theme)
}

export function selectTheme(id: string): ThemeDefinition {
  const theme = findTheme(id)
  writeStored(STORAGE_KEY, theme.id)
  applyTheme(theme)
  return theme
}

/**
 * Appearance: the colour theme and the reader's text size and line height. Settings previews a choice at once,
 * and saves or reverts it with the page's own 保存全部更改 / 放弃更改.
 */
export interface Appearance {
  themeId: string
  readerFontSize: number
  readerLineHeight: number
}

const FONT_KEY = 'copilotix.reader.font-size.v1'
export const READER_FONT_SIZES = { min: 13, max: 22, step: 1, default: 16 } as const
const LINE_HEIGHT_KEY = 'copilotix.reader.line-height.v1'
/** Multiples of the font size; the old fixed value was 1.78. */
export const READER_LINE_HEIGHTS = { min: 1.4, max: 2.4, step: 0.1, default: 1.8 } as const

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // The choice still applies for this session.
  }
}

function clampFontSize(value: number): number {
  if (!Number.isFinite(value)) return READER_FONT_SIZES.default
  return Math.min(READER_FONT_SIZES.max, Math.max(READER_FONT_SIZES.min, Math.round(value)))
}

export function clampLineHeight(value: number): number {
  if (!Number.isFinite(value)) return READER_LINE_HEIGHTS.default
  return Math.min(READER_LINE_HEIGHTS.max, Math.max(READER_LINE_HEIGHTS.min, Math.round(value * 10) / 10))
}

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

export function storedAppearance(): Appearance {
  const size = readStored(FONT_KEY)
  const lineHeight = readStored(LINE_HEIGHT_KEY)
  return {
    themeId: findTheme(storedThemeId()).id,
    readerFontSize: size === null ? READER_FONT_SIZES.default : clampFontSize(Number(size)),
    readerLineHeight: lineHeight === null ? READER_LINE_HEIGHTS.default : clampLineHeight(Number(lineHeight))
  }
}

/** Applies an appearance without remembering it. */
export function previewAppearance(appearance: Appearance, root: HTMLElement = document.documentElement): void {
  if (current.id !== appearance.themeId || root.dataset.colorTheme !== appearance.themeId) applyTheme(findTheme(appearance.themeId), root)
  root.style.setProperty('--reader-font-size', `${clampFontSize(appearance.readerFontSize)}px`)
  root.style.setProperty('--reader-line-height', String(clampLineHeight(appearance.readerLineHeight)))
}

export function saveAppearance(appearance: Appearance): void {
  writeStored(STORAGE_KEY, findTheme(appearance.themeId).id)
  writeStored(FONT_KEY, String(clampFontSize(appearance.readerFontSize)))
  writeStored(LINE_HEIGHT_KEY, String(clampLineHeight(appearance.readerLineHeight)))
  previewAppearance(appearance)
}

export function restoreTheme(): ThemeDefinition {
  previewAppearance(storedAppearance())
  return current
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
