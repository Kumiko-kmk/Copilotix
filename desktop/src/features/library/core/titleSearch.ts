/** Local title matching: Unicode, case/diacritics, punctuation and non-adjacent keywords. */
export function titleSearchText(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

export function matchesTitleSearch(titles: readonly string[], query: string): boolean {
  const terms = query.trim().split(/\s+/u).map(titleSearchText).filter(Boolean)
  if (!terms.length) return true
  const candidates = titles.map(titleSearchText)
  return terms.every(term => candidates.some(title => {
    if (title.includes(term)) return true
    let offset = 0
    for (const letter of term) {
      const next = title.indexOf(letter, offset)
      if (next < 0) return false
      offset = next + letter.length
    }
    return true
  }))
}
