/**
 * Content categories for the library columns. Pure functions, no model call:
 *
 * 1. Each paper contributes a representative text (title, abstract, conclusion and the most
 *    informative paragraphs, see PaperInsightStore.categoryText), tokenised into Latin words and
 *    Chinese words (ICU segmenter).
 * 2. TF-IDF vectors (sublinear tf, top terms only) and cosine similarity through an inverted
 *    index, so cost follows term overlap rather than the square of the library size.
 * 3. A nearest-neighbour graph split into communities with Louvain; the resolution is chosen for
 *    good modularity near √n groups, never one group per paper.
 * 4. Names come from the members' AI file cards (field.area) when there are any, otherwise from
 *    the group's most distinctive shared words (c-TF-IDF).
 */
import { createHash } from 'node:crypto'
import { ALL_PAPERS_NAME, CATEGORY_NAME_MAX } from '../contract/libraryCategories'

export interface CategorySource {
  id: string
  createdAt: string
  /** Term counts of the paper's representative text; null when it has no readable text yet. */
  terms: ReadonlyMap<string, number> | null
  /** field.area of the paper's AI file card, when it has one. */
  area: string | null
}

export interface ClassifiedCategory {
  id: string
  name: string
  named: 'brief' | 'terms' | 'pending'
  /** Most typical paper first. */
  paperIds: string[]
}

const STOP_LATIN = new Set(('the and for with that this from are was were have has been not but can our its their which into using use used ' +
  'based between also more than such these those each other over then there when where while both only one two three new all any may via per ' +
  'data model models method methods results paper show shows figure table section learning neural network networks fig eq et al ' +
  'com http https www doi org arxiv preprint vol pp').split(' '))
const STOP_CJK = new Set(('我们 一个 一种 可以 以及 通过 使用 进行 由于 因此 其中 这些 这个 我们的 的是 是一 在一 了一 中的 上的 为了 对于 ' +
  '如图 如表 所示 表示 图中 方法 模型 结果 本文 论文 提出 不同 相同 以下 以上 之间 他们 它们 没有 已经 能够 需要 非常 每个 所有 包括 例如 ' +
  '其他 时间 情况 部分 问题 研究 工作 数据 学习 训练 网络 实验 性能').split(' '))
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
const HAN = /^[\p{Script=Han}]+$/u
const TOP_TERMS = 200
const NEIGHBOURS = 5

/** Term counts for a text: Latin words of 3+ letters and Chinese words; runs of single characters the
 * segmenter could not join (傅|里|叶) are kept whole when short, as bigrams otherwise. */
export function categoryTerms(text: string): Map<string, number> {
  const counts = new Map<string, number>()
  const add = (term: string): void => { counts.set(term, (counts.get(term) ?? 0) + 1) }
  // Formulas and LaTeX commands ("\mathbf", "\lambda") say nothing about the topic.
  text = text.replace(/\$\$[\s\S]*?\$\$|\$[^$\n]*\$|\\[A-Za-z]+/gu, ' ')
  for (const word of text.toLowerCase().match(/[a-z][a-z-]{2,}/gu) ?? []) if (!STOP_LATIN.has(word)) add(word)
  for (const run of text.match(/\p{Script=Han}{2,}/gu) ?? []) {
    let singles = ''
    const flush = (): void => {
      if (singles.length >= 2 && singles.length <= 5) add(singles)
      else for (let index = 0; index + 1 < singles.length; index++) add(singles.slice(index, index + 2))
      singles = ''
    }
    for (const { segment } of segmenter.segment(run)) {
      if (!HAN.test(segment)) continue
      if (segment.length === 1) { singles += segment; continue }
      flush()
      if (!STOP_CJK.has(segment)) add(segment)
    }
    flush()
  }
  return counts
}

type Vector = Array<[term: number, weight: number]>

function louvain(count: number, edges: ReadonlyArray<{ a: number; b: number; w: number }>, resolution: number): number[] {
  const weight = Array.from({ length: count }, () => new Map<number, number>())
  for (const { a, b, w } of edges) {
    weight[a]!.set(b, (weight[a]!.get(b) ?? 0) + w)
    weight[b]!.set(a, (weight[b]!.get(a) ?? 0) + w)
  }
  const degree = weight.map((map) => [...map.values()].reduce((sum, value) => sum + value, 0))
  const total = degree.reduce((sum, value) => sum + value, 0) / 2 || 1
  const community = Array.from({ length: count }, (_, index) => index)
  const communityDegree = degree.slice()
  let moved = true
  for (let pass = 0; moved && pass < 60; pass++) {
    moved = false
    for (let node = 0; node < count; node++) {
      const own = community[node]!
      const links = new Map<number, number>()
      for (const [other, w] of weight[node]!) links.set(community[other]!, (links.get(community[other]!) ?? 0) + w)
      communityDegree[own]! -= degree[node]!
      const gain = (target: number): number => (links.get(target) ?? 0) - resolution * communityDegree[target]! * degree[node]! / (2 * total)
      let best = own
      let bestGain = gain(own)
      for (const target of links.keys()) {
        const value = gain(target)
        if (value > bestGain + 1e-12) { best = target; bestGain = value }
      }
      communityDegree[best]! += degree[node]!
      if (best !== own) { community[node] = best; moved = true }
    }
  }
  return community
}

function modularity(community: readonly number[], edges: ReadonlyArray<{ a: number; b: number; w: number }>): number {
  const m = edges.reduce((sum, edge) => sum + edge.w, 0) || 1
  const degree = new Map<number, number>()
  let inside = 0
  for (const { a, b, w } of edges) {
    if (community[a] === community[b]) inside += w
    degree.set(community[a]!, (degree.get(community[a]!) ?? 0) + w)
    degree.set(community[b]!, (degree.get(community[b]!) ?? 0) + w)
  }
  let expected = 0
  for (const d of degree.values()) expected += (d / (2 * m)) ** 2
  return inside / m - expected
}

const clipName = (name: string): string => {
  const clean = name.replace(/\s+/gu, ' ').trim()
  return clean.length > CATEGORY_NAME_MAX ? `${clean.slice(0, CATEGORY_NAME_MAX - 1)}…` : clean
}

export function classifyLibrary(sources: readonly CategorySource[]): ClassifiedCategory[] {
  const ready = sources.filter((source) => source.terms && source.terms.size > 0)
  const pending = sources.filter((source) => !source.terms || source.terms.size === 0)
  const newestFirst = (a: CategorySource, b: CategorySource): number => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)
  const result: ClassifiedCategory[] = []
  const n = ready.length

  // Vocabulary: shared by at least two papers, not by most of the library.
  const df = new Map<string, number>()
  for (const source of ready) for (const term of source.terms!.keys()) df.set(term, (df.get(term) ?? 0) + 1)
  const maxDf = Math.max(2, Math.floor(n * 0.5))
  const vocabulary = [...df.entries()].filter(([, count]) => count >= 2 && count <= maxDf).map(([term]) => term)
  const index = new Map(vocabulary.map((term, position) => [term, position]))
  const idf = vocabulary.map((term) => Math.log((1 + n) / (1 + df.get(term)!)) + 1)

  const vectors: Vector[] = ready.map((source) => {
    const entries: Vector = []
    for (const [term, count] of source.terms!) {
      const position = index.get(term)
      if (position !== undefined) entries.push([position, (1 + Math.log(count)) * idf[position]!])
    }
    entries.sort((a, b) => b[1] - a[1])
    const top = entries.slice(0, TOP_TERMS)
    const norm = Math.sqrt(top.reduce((sum, [, w]) => sum + w * w, 0)) || 1
    return top.map(([term, w]) => [term, w / norm] as [number, number])
  })

  let groups: number[][]
  if (n < 4 || vocabulary.length < 8) groups = n ? [ready.map((_, position) => position)] : []
  else {
    // Cosine similarity through an inverted index; each paper keeps its nearest neighbours.
    const postings = vocabulary.map(() => [] as Array<[number, number]>)
    vectors.forEach((vector, paper) => { for (const [term, w] of vector) postings[term]!.push([paper, w]) })
    const accumulator = new Float64Array(n)
    const edgeMap = new Map<string, { a: number; b: number; w: number }>()
    const similarity = (a: number, b: number): number => {
      let sum = 0
      const other = new Map(vectors[b])
      for (const [term, w] of vectors[a]!) sum += w * (other.get(term) ?? 0)
      return sum
    }
    for (let paper = 0; paper < n; paper++) {
      accumulator.fill(0)
      for (const [term, w] of vectors[paper]!) for (const [other, wo] of postings[term]!) if (other !== paper) accumulator[other]! += w * wo
      const nearest = [...accumulator.keys()].filter((other) => other !== paper && accumulator[other]! > 0.02)
        .sort((a, b) => accumulator[b]! - accumulator[a]!).slice(0, NEIGHBOURS)
      for (const other of nearest) {
        const key = paper < other ? `${paper}:${other}` : `${other}:${paper}`
        if (!edgeMap.has(key)) edgeMap.set(key, { a: Math.min(paper, other), b: Math.max(paper, other), w: accumulator[other]! })
      }
    }
    const edges = [...edgeMap.values()]
    // About √n columns (4 for 14 papers, 6 for 37, 10 for 100): enough to separate topics, few
    // enough to browse. Among the resolutions tried, modularity decides, nudged toward that count.
    const target = Math.max(2, Math.round(Math.sqrt(n)))
    let best: { community: number[]; score: number } | null = null
    for (let step = 0; step <= 14; step++) {
      const community = louvain(n, edges, 0.5 + step * 0.25)
      const count = new Set(community).size
      const score = modularity(community, edges) - 0.03 * Math.abs(count - target) - (count > n / 2 ? 1 : 0)
      if (!best || score > best.score) best = { community, score }
    }
    const byId = new Map<number, number[]>()
    best!.community.forEach((id, paper) => byId.set(id, [...(byId.get(id) ?? []), paper]))
    groups = [...byId.values()]
    // A lone paper joins the group it is most like, so no column holds a single paper by accident.
    if (n >= 6) {
      const singles = groups.filter((group) => group.length === 1)
      groups = groups.filter((group) => group.length > 1)
      for (const [paper] of singles) {
        let target = -1
        let strongest = 0
        groups.forEach((group, position) => {
          const mean = group.reduce((sum, other) => sum + similarity(paper!, other), 0) / group.length
          if (mean > strongest) { strongest = mean; target = position }
        })
        if (target >= 0) groups[target]!.push(paper!)
        else groups.push([paper!])
      }
    }
  }

  // Names and order.
  const totalTerms = new Map<string, number>()
  for (const source of ready) for (const [term, count] of source.terms!) if (index.has(term)) totalTerms.set(term, (totalTerms.get(term) ?? 0) + count)
  const averageSize = groups.length ? [...totalTerms.values()].reduce((a, b) => a + b, 0) / groups.length : 1
  const used = new Set<string>()
  const named = groups.map((members) => {
    const centroid = new Map<number, number>()
    for (const paper of members) for (const [term, w] of vectors[paper]!) centroid.set(term, (centroid.get(term) ?? 0) + w)
    const centrality = (paper: number): number => vectors[paper]!.reduce((sum, [term, w]) => sum + w * (centroid.get(term) ?? 0), 0)
    // One group is the whole library: keep the newest-first order it had before categories loaded.
    const single = groups.length === 1
    const ordered = members.slice().sort((a, b) => single ? newestFirst(ready[a]!, ready[b]!) : centrality(b) - centrality(a) || newestFirst(ready[a]!, ready[b]!))
    // Prefer the file cards' own words for the field, weighted toward the most typical papers.
    const areas = new Map<string, number>()
    ordered.forEach((paper, rank) => {
      const area = ready[paper]!.area?.trim()
      if (area) areas.set(area, (areas.get(area) ?? 0) + 1 / (1 + rank) + 1)
    })
    // One group is the whole library; a single paper's field would misname it.
    let name = single ? ALL_PAPERS_NAME : [...areas.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
    let source: ClassifiedCategory['named'] = single ? 'terms' : 'brief'
    if (!name) {
      source = 'terms'
      const groupTerms = new Map<string, number>()
      const spread = new Map<string, number>()
      for (const paper of members) for (const [term, count] of ready[paper]!.terms!) {
        if (!index.has(term)) continue
        groupTerms.set(term, (groupTerms.get(term) ?? 0) + count)
        spread.set(term, (spread.get(term) ?? 0) + 1)
      }
      const size = [...groupTerms.values()].reduce((a, b) => a + b, 0) || 1
      const words = [...groupTerms.entries()]
        .filter(([term]) => members.length < 2 || (spread.get(term) ?? 0) >= 2)
        .map(([term, count]) => [term, (count / size) * Math.log(1 + averageSize / totalTerms.get(term)!) * (/\p{Script=Han}/u.test(term) ? 1.2 : 1)] as const)
        .sort((a, b) => b[1] - a[1])
      const picked: string[] = []
      for (const [term] of words) {
        if (picked.length >= 2) break
        if (!picked.some((other) => other.includes(term) || term.includes(other))) picked.push(term)
      }
      name = picked.join(' · ')
    }
    name = clipName(name || '未命名分类')
    let unique = name
    for (let suffix = 2; used.has(unique); suffix++) unique = clipName(`${name} ${suffix}`)
    used.add(unique)
    const paperIds = ordered.map((paper) => ready[paper]!.id)
    return { id: `c-${createHash('sha1').update(paperIds.slice().sort().join('|')).digest('hex').slice(0, 12)}`, name: unique, named: source, paperIds }
  })
  named.sort((a, b) => b.paperIds.length - a.paperIds.length || a.name.localeCompare(b.name, 'zh'))
  result.push(...named)
  if (pending.length) result.push({ id: 'pending', name: '待分类', named: 'pending', paperIds: pending.slice().sort(newestFirst).map((source) => source.id) })
  return result
}
