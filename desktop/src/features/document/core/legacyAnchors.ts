/** Legacy notes/annotations keep their files; only a unique textual match may move to another block. */
export function resolveLegacyTextAnchor(texts: ReadonlyMap<string, string>, anchor: { blockKey: string; quote: string; prefix: string; suffix: string }): string | null {
  if (!anchor.quote) return null
  if (anchor.blockKey.startsWith('document:') && texts.get(anchor.blockKey)?.includes(anchor.quote)) return anchor.blockKey
  const candidates = [...texts].filter(([, text]) => text.includes(anchor.quote))
  if (candidates.length === 1) return candidates[0]![0]
  const contextual = candidates.filter(([, text]) => text.includes(anchor.prefix + anchor.quote + anchor.suffix))
  return (anchor.prefix || anchor.suffix) && contextual.length === 1 ? contextual[0]![0] : null
}
