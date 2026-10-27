import { unified } from 'unified'
import remarkParse from 'remark-parse'
import { figureAssetName, type ReaderFigureGeometry } from './readerFigureGroups'
import { isLocalMarkdownImage } from '@platform/markdown/core/standardMarkdown'

export interface FigureArtifact {
  figureId: string
  imagePath: string
  sourceRevision: string
  pageIndex: number
  cropBox: ReaderFigureGeometry['cropBox']
  mappingIds: string[]
  sourceAssets: string[]
  width: number
  height: number
  pngSha256: string
}
export interface FigureArtifactManifest { version: 1; figures: FigureArtifact[] }
type ImageNode = { type: string; url?: string; identifier?: string; children?: ImageNode[];
  position?: { start: { offset?: number }; end: { offset?: number } } }

/** A derived sharing/export projection; original Markdown and mappings stay intact. */
export function projectFigureMarkdown(markdown: string, figures: readonly FigureArtifact[]): string {
  const owners = new Map<string, FigureArtifact | null>()
  for (const figure of figures) for (const asset of figure.sourceAssets) {
    const name = figureAssetName(asset)
    const previous = owners.get(name)
    owners.set(name, previous && previous.figureId !== figure.figureId ? null : previous === null ? null : figure)
  }
  const tree = unified().use(remarkParse).parse(markdown) as ImageNode
  const definitions = new Map<string, string>()
  const collectDefinitions = (node: ImageNode): void => {
    if (node.type === 'definition' && node.identifier && node.url) definitions.set(node.identifier.toLowerCase(), node.url)
    node.children?.forEach(collectDefinitions)
  }
  collectDefinitions(tree)
  const inserted = new Set<string>()
  const edits: Array<{ start: number; end: number; text: string }> = []
  const replace = (url: string, start?: number, end?: number, html = false): void => {
    if (!isLocalMarkdownImage(url)) return
    const figure = owners.get(figureAssetName(url))
    if (!figure || start === undefined || end === undefined) return
    edits.push({ start, end, text: inserted.has(figure.figureId) ? '' : html
      ? '<img src="' + figure.imagePath + '" alt="">' : '![](' + figure.imagePath + ')' })
    inserted.add(figure.figureId)
  }
  const visit = (node: ImageNode): void => {
    const start = node.position?.start.offset, end = node.position?.end.offset
    if (node.type === 'image' && node.url) replace(node.url, start, end)
    else if (node.type === 'imageReference' && node.identifier) {
      const url = definitions.get(node.identifier.toLowerCase())
      if (url) replace(url, start, end)
    } else if (node.type === 'html' && start !== undefined && end !== undefined) {
      const html = markdown.slice(start, end)
      for (const match of html.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/giu)) {
        replace(match[1]!, start + match.index, start + match.index + match[0].length, true)
      }
    }
    node.children?.forEach(visit)
  }
  visit(tree)
  for (const edit of edits.sort((a, b) => b.start - a.start)) markdown = markdown.slice(0, edit.start) + edit.text + markdown.slice(edit.end)
  return markdown
}
