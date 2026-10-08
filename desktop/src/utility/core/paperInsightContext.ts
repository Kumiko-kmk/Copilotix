import type { PaperInsightContext } from '@shared/paperInsight'

/** UTF-8 bytes conservatively upper-bound content tokens, including mixed CJK/English. */
export function takeInsightBytes(text: string, limit: number): string {
  const bytes = Buffer.from(text)
  if (bytes.length <= limit) return text
  let end = limit
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--
  return bytes.subarray(0, end).toString('utf8')
}

/** Only paper text is passed to Main: title, abstract, conclusion and section openings. */
export function selectInsightExcerpts(markdown: string, budgetBytes: number): Pick<PaperInsightContext, 'excerpts' | 'truncated'> {
  const clean = markdown.replace(/!\[[^\]]*\]\([^)]*\)/gu, '').replace(/<[^>]*>/gu, ' ').replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
  const sections: Array<{ section: string; text: string; priority: number }> = []
  let current = { section: '标题与开篇', text: '', priority: 0 }
  for (const line of clean.split(/\r?\n/u)) {
    const heading = /^\s*#{1,6}\s+(.+)$/u.exec(line)
    if (heading) {
      if (current.text.trim()) sections.push(current)
      const title = heading[1]!.trim()
      const priority = /abstract|摘要/iu.test(title) ? 1 : /conclu|总结|结论/iu.test(title) ? 2
        : /method|approach|方法/iu.test(title) ? 3 : 4
      current = { section: title.slice(0, 200) || '章节', text: title + '\n', priority: sections.length === 0 && !current.text.trim() ? 0 : priority }
    } else current.text += line + '\n'
  }
  if (current.text.trim()) sections.push(current)
  const ordered = sections.filter((part) => !/^(?:\d+[.\s]*)?(?:references|bibliography|参考文献)$/iu.test(part.section))
    .sort((a, b) => a.priority - b.priority)
  const excerpts: PaperInsightContext['excerpts'] = []
  let remaining = Math.min(8192, Math.max(2048, budgetBytes))
  let truncated = false
  for (const part of ordered) {
    if (remaining < 80 || excerpts.length >= 32) { truncated = true; break }
    remaining -= Buffer.byteLength(part.section) + 48
    if (remaining < 80) { truncated = true; break }
    const allowance = Math.min(remaining, part.priority <= 2 ? 2000 : 1000)
    const full = part.text.trim()
    const text = takeInsightBytes(full, allowance).trim()
    if (text) excerpts.push({ section: part.section, text })
    remaining -= Buffer.byteLength(text)
    truncated ||= text.length < full.length
  }
  if (!excerpts.length) throw new Error('论文尚无可供解读的正文')
  return { excerpts, truncated }
}
