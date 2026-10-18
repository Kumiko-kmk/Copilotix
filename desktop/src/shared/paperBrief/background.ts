/** Background remains a string in saved v2 records; new briefs use titled paragraphs. */
export function backgroundPoints(text: string): Array<{ title: string; text: string }> {
  const paragraphs = text.split(/\n\s*\n/u).map(part => part.trim()).filter(Boolean)
  // Old one-paragraph briefs keep every sentence, grouped into at most three reading points.
  const sentences = paragraphs.length === 1 ? text.match(/[^。！？]+[。！？]?[”’]?/gu) ?? [text] : []
  const parts = sentences.length > 1
    ? Array.from({ length: Math.min(3, sentences.length) }, (_, index) => {
      const count = Math.min(3, sentences.length)
      return sentences.slice(Math.floor(index * sentences.length / count), Math.floor((index + 1) * sentences.length / count)).join('').trim()
    }) : paragraphs
  return parts.map(part => {
    const heading = /^([^：\n]{2,24})：\s*([\s\S]+)$/u.exec(part)
    return heading ? { title: heading[1]!, text: heading[2]! } : { title: '', text: part }
  })
}
