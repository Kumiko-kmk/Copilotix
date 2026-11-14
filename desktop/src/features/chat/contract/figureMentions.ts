/**
 * Figure references in paper text: "Fig. 1", "Figs. 2a and 3(b)", "Figures 1–3", "图 1(a)",
 * "Supplementary Fig. S2". Keys ignore panel letters, so "Fig. 1b" mentions figure 1.
 */
const WORD = /(?:(supplementary|extended\s+data)\s+)?(?:fig(?:ure)?s?\.?|[附补補]?[图圖])\s*/giu
const NUMBER = /^([A-Z]\.?\s*)?(\d{1,3})(?!\d)/u
const PANELS = /^(?:\s*[（(]\s*[a-z](?:\s*[-–—,，、]\s*[a-z])*\s*[)）]|[a-z](?:[-–—][a-z])?(?![A-Za-z]))/u
const SEPARATOR = /^\s*(,|，|、|and|&|or|to|–|—|-|和|与|與|及|至)\s*(?=[A-Z]?\.?\s*\d)/iu

export interface FigureMention { key: string; start: number; end: number; panels: string[] }

function figureKey(kind: string | undefined, prefix: string | undefined, number: string): string {
  const scope = kind ? (/^s/iu.test(kind) ? 'supplementary:' : 'extended:') : ''
  return scope + (prefix ?? '').replace(/[.\s]/gu, '').toUpperCase() + String(Number(number))
}

export function figureMentions(text: string): FigureMention[] {
  const mentions: FigureMention[] = []
  for (const match of text.matchAll(WORD)) {
    const start = match.index
    // "configure 1" or "transfig 2" are words, not references.
    if (start > 0 && /[A-Za-z]/u.test(text[start - 1]!)) continue
    let position = start + match[0].length
    let first = NUMBER.exec(text.slice(position))
    if (!first) continue
    let previous: number | null = null
    let range = false
    while (first) {
      position += first[0].length
      const value = Number(first[2])
      const panels: string[] = []
      const panel = PANELS.exec(text.slice(position))
      if (panel) { position += panel[0].length; panels.push(...(panel[0].match(/[a-z]/gu) ?? [])) }
      // "Figs. 1–3" also mentions figure 2; bounded so a typo cannot add hundreds of keys.
      if (range && previous !== null && value > previous && value - previous <= 20) {
        for (let n = previous + 1; n < value; n++) mentions.push({ key: figureKey(match[1], first[1], String(n)), start, end: position, panels: [] })
      }
      mentions.push({ key: figureKey(match[1], first[1], first[2]!), start, end: position, panels })
      previous = value
      const separator = SEPARATOR.exec(text.slice(position))
      if (!separator) break
      range = /^(?:–|—|-|to|至)$/iu.test(separator[1]!)
      const next = NUMBER.exec(text.slice(position + separator[0].length))
      if (!next) break
      position += separator[0].length
      first = next
    }
  }
  return mentions
}

/** The figure a caption introduces, from its leading label; null for unlabelled figures. */
export function captionFigureKey(caption: string): { key: string; label: string } | null {
  const trimmed = caption.replace(/^[\s*_#>]+/u, '')
  const mention = figureMentions(trimmed)[0]
  if (!mention || mention.start !== 0) return null
  return { key: mention.key, label: trimmed.slice(0, mention.end).replace(/[\s(（]+$/u, '').trim().slice(0, 64) }
}

export function mentionsFigure(text: string, key: string): boolean {
  return figureMentions(text).some(mention => mention.key === key)
}
