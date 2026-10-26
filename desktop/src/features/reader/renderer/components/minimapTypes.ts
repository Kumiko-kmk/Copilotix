
/** Content model shared by the minimap's measurement, painting and component. */

export interface MarkdownMinimapTextRun {
  id: string
  text: string
  left: number
  baseline: number
  width: number
  fontSize: number
  fontWeight: string
  fontStyle: string
  tone: 'body' | 'code' | 'heading'
}

export interface MarkdownMinimapHeading {
  id: string
  top: number
  height: number
  left: number
  width: number
  documentTop: number
  headingLevel: number
  title: string
  element?: HTMLElement
}

export interface MarkdownMinimapImage {
  id: string
  left: number
  top: number
  width: number
  height: number
  element: HTMLImageElement | HTMLCanvasElement
  sourceWidth: number
  sourceHeight: number
}

export interface MarkdownMinimapHighlight {
  id: string
  left: number
  top: number
  width: number
  height: number
}

export interface MarkdownMinimapFormula {
  id: string
  left: number
  top: number
  width: number
  height: number
  element: HTMLElement
  sourceWidth: number
  sourceHeight: number
  color: string
  fontFamily: string
  fontSize: string
}

export interface MarkdownMinimapContent {
  geometry: MarkdownMinimapGeometry
  textRuns: MarkdownMinimapTextRun[]
  headings: MarkdownMinimapHeading[]
  images: MarkdownMinimapImage[]
  formulas: MarkdownMinimapFormula[]
  highlights: MarkdownMinimapHighlight[]
}

export interface MarkdownMinimapGeometry {
  railWidth: number
  railHeight: number
  documentHeight: number
  viewportHeight: number
  verticalScale: number
  maxScroll: number
}

export interface MinimapNavigationAnchor {
  sourceTop: number
  liveTop: number
  element?: HTMLElement
  edge?: 'top' | 'bottom'
}
