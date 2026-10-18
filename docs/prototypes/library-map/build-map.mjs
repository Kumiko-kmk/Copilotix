// Library graph prototype: groups a folder of parsed papers by overall relatedness (content,
// citations, shared references) for an Obsidian-style graph view.
// Runs locally with Node 20+ and no dependencies, API keys or downloads, so the demo shows the
// pipeline shape (chunk → vectorise → cluster → name → cite → lay out) rather than the final
// model quality. Production would swap the TF-IDF/LSA step for an embedding model (see README).
//
//   node build-map.mjs <corpus-dir> <manifest.json> <out.json> [page.html]
//
// <corpus-dir>/<documentId>/paper.compat.md is a translated MinerU paper; the manifest gives each
// document's original (English) title, used to find citations between papers in the library.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const [corpusDir, manifestPath, outPath, htmlPath] = process.argv.slice(2)
if (!corpusDir || !manifestPath || !outPath) {
  console.error('usage: node build-map.mjs <corpus-dir> <manifest.json> <out.json>')
  process.exit(1)
}

const LSA_DIMENSIONS = 24
const CHUNK_CHARS = 520
const SEED = 20261010

// ───────────── Parsing and chunking ─────────────

const DROP_SECTION = /^(参考文献|references?|bibliography|致谢|acknowledg|附录|appendix|作者贡献|利益冲突|同行评审|出版者声明|相关链接|收到日期|数据可用|代码可用|[a-h](?:\.\d+)*\.?\s)/iu
// Nature-style papers list references without a heading: numbered lines with authors and a year.
const REFERENCE_LINE = /^\s*(?:\[\d+\]|\d{1,3}\.)\s+\S.{20,}(?:\(\d{4}\)|\b(?:19|20)\d{2}\b|et al)/u
const ROLE = [
  ['abstract', /摘要|abstract/iu],
  ['introduction', /引言|介绍|简介|introduction|背景|background|相关工作|related/iu],
  ['method', /方法|模型|架构|算法|method|model|architecture|approach|框架|理论|公式|设计/iu],
  ['results', /实验|结果|评估|评价|experiment|result|evaluation|基准|性能|消融/iu],
  ['conclusion', /结论|讨论|总结|局限|conclusion|discussion|limitation|展望/iu]
]

function clean(text) {
  return text
    .replace(/�/gu, '')
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/^\s*\|.*\|\s*$/gmu, ' ')
    .replace(/<\/?[A-Za-z][^<>\n]{0,300}>/gu, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\$\$[\s\S]*?\$\$/gu, ' ')
    .replace(/\$[^$\n]{0,200}\$/gu, ' ')
    .replace(/\\[A-Za-z]+/gu, ' ')
    .replace(/\\\[\d[\d,\s–-]*\]/gu, ' ')
    .replace(/[ \t]+/gu, ' ')
    .trim()
}

function parsePaper(markdown) {
  const lines = markdown.split(/\r?\n/u)
  const sections = []
  let current = { heading: '', level: 0, lines: [] }
  const references = []
  let inReferences = false
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line)
    if (heading) {
      sections.push(current)
      const title = heading[2].trim()
      // Not \b: in JavaScript it never matches after a CJK character.
      inReferences = /^(?:\d+\.?\s*)?(参考文献|references?|bibliography)(?![A-Za-z])/iu.test(title)
      current = { heading: title, level: heading[1].length, lines: [] }
      continue
    }
    if (inReferences || REFERENCE_LINE.test(line)) {
      references.push(line)
      continue
    }
    current.lines.push(line)
  }
  sections.push(current)
  const title = sections.find((section) => section.level === 1)?.heading ?? sections[1]?.heading ?? ''
  let role = 'body'
  let dropping = false
  const kept = []
  for (const section of sections) {
    if (section.heading) {
      const plain = section.heading.replace(/^[\d.\sIVX]+/u, '').trim()
      dropping = DROP_SECTION.test(section.heading) || DROP_SECTION.test(plain)
      if (section.level <= 2 || !/^\d+\.\d/u.test(section.heading)) {
        role = ROLE.find(([, pattern]) => pattern.test(plain))?.[0] ?? (kept.length ? 'body' : 'abstract')
      }
    }
    if (dropping || section.level === 1) continue
    kept.push({ heading: section.heading, role, text: clean(section.lines.join('\n')) })
  }
  return { title, sections: kept, references: references.join('\n') }
}

function chunkPaper(paper) {
  const chunks = []
  for (const section of paper.sections) {
    const paragraphs = section.text.split(/\n\s*\n/u).map((part) => part.replace(/\s*\n\s*/gu, ' ').trim()).filter((part) => part.length > 24)
    let buffer = ''
    const flush = () => {
      if (buffer.length > 60) chunks.push({ section: section.heading, role: section.role, text: buffer })
      buffer = ''
    }
    for (const paragraph of paragraphs) {
      if (buffer && buffer.length + paragraph.length > CHUNK_CHARS) flush()
      if (paragraph.length > CHUNK_CHARS * 1.6) {
        flush()
        // Split long paragraphs at sentence ends.
        for (const sentence of paragraph.match(/[^。！？.!?]+[。！？.!?]?/gu) ?? [paragraph]) {
          if (buffer.length + sentence.length > CHUNK_CHARS) flush()
          buffer += sentence
        }
        flush()
      } else buffer += (buffer ? ' ' : '') + paragraph
    }
    flush()
  }
  return chunks
}

// ───────────── Tokens and TF-IDF ─────────────

const STOP_LATIN = new Set('the and for with that this from are was were have has been not but can our its their which into using use used based between also more than such these those each other over then there when where while both only one two three new all any may via per data model models method methods results paper show shows figure table section learning neural network networks com http https www doi org arxiv preprint vol pp'.split(' '))
const STOP_CJK = new Set('我们 一个 一种 可以 以及 通过 使用 进行 由于 因此 其中 这些 这个 我们的 的是 是一 在一 了一 中的 上的 和的 为了 对于 如图 如表 所示 表示 图中 方法 模型 结果 本文 论文 提出 不同 相同 以下 以上 之间 他们 它们 没有 已经 能够 需要 非常 每个 所有 包括 例如 其他 时间 情况 部分'.split(' '))

// Chinese words from the ICU dictionary segmenter (built into Node and browsers, so the page can
// tokenise a query the same way). Runs of single characters it could not join ("算|子") are
// kept as bigrams.
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
const CJK = /^[一-鿿]+$/u

function tokens(text) {
  const out = []
  for (const word of text.toLowerCase().match(/[a-z][a-z-]{2,}/gu) ?? []) if (!STOP_LATIN.has(word)) out.push(word)
  for (const run of text.match(/[一-鿿]{2,}/gu) ?? []) {
    let singles = ''
    const flush = () => {
      // Short runs are usually one transliterated or technical word (傅里叶, 马尔可夫).
      if (singles.length >= 2 && singles.length <= 5) out.push(singles)
      else for (let index = 0; index + 1 < singles.length; index++) out.push(singles.slice(index, index + 2))
      singles = ''
    }
    for (const { segment } of segmenter.segment(run)) {
      if (!CJK.test(segment)) continue
      if (segment.length === 1) { singles += segment; continue }
      flush()
      if (!STOP_CJK.has(segment)) out.push(segment)
    }
    flush()
  }
  return out
}

function counts(list) {
  const map = new Map()
  for (const item of list) map.set(item, (map.get(item) ?? 0) + 1)
  return map
}

// ───────────── Small linear algebra ─────────────

function rng(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0)
const norm = (a) => Math.sqrt(dot(a, a)) || 1
const normalize = (a) => { const n = norm(a); return a.map((value) => value / n) }

function orthonormalColumns(columns) {
  const out = []
  for (const column of columns) {
    let v = column.slice()
    for (const q of out) { const projection = dot(v, q); v = v.map((value, index) => value - projection * q[index]) }
    const n = Math.sqrt(dot(v, v))
    if (n > 1e-10) out.push(v.map((value) => value / n))
  }
  return out
}

/** Symmetric eigen-decomposition (Jacobi), for the small k×k matrix of the randomized SVD. */
function jacobiEigen(matrix) {
  const n = matrix.length
  const a = matrix.map((row) => row.slice())
  const v = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)))
  for (let sweep = 0; sweep < 80; sweep++) {
    let off = 0
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] ** 2
    if (off < 1e-18) break
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-14) continue
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q])
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const c = 1 / Math.sqrt(t * t + 1)
        const s = t * c
        for (let k = 0; k < n; k++) {
          const akp = a[k][p]
          const akq = a[k][q]
          a[k][p] = c * akp - s * akq
          a[k][q] = s * akp + c * akq
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k]
          const aqk = a[q][k]
          a[p][k] = c * apk - s * aqk
          a[q][k] = s * apk + c * aqk
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p]
          const vkq = v[k][q]
          v[k][p] = c * vkp - s * vkq
          v[k][q] = s * vkp + c * vkq
        }
      }
    }
  }
  return Array.from({ length: n }, (_, i) => ({ value: a[i][i], vector: v.map((row) => row[i]) })).sort((x, y) => y.value - x.value)
}

// ───────────── Pipeline ─────────────

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const papers = []
for (const entry of manifest) {
  const file = join(corpusDir, entry.documentId, 'paper.compat.md')
  if (!existsSync(file)) continue
  const parsed = parsePaper(readFileSync(file, 'utf8'))
  const chunks = chunkPaper(parsed)
  if (!chunks.length) continue
  papers.push({ id: entry.documentId, title: parsed.title, original: entry.title, references: parsed.references, chunks, bytes: Buffer.byteLength(readFileSync(file)) })
}
console.log(`papers: ${papers.length}`)

const chunks = papers.flatMap((paper, paperIndex) => paper.chunks.map((chunk) => ({ ...chunk, paper: paperIndex, terms: counts(tokens(chunk.text)) })))
console.log(`chunks: ${chunks.length}`)

// Vocabulary: terms in at least 2 chunks and at most 35% of them.
const df = new Map()
for (const chunk of chunks) for (const term of chunk.terms.keys()) df.set(term, (df.get(term) ?? 0) + 1)
const vocab = [...df.entries()].filter(([, count]) => count >= 2 && count <= chunks.length * 0.35).map(([term]) => term)
const termIndex = new Map(vocab.map((term, index) => [term, index]))
const idf = vocab.map((term) => Math.log((1 + chunks.length) / (1 + df.get(term))) + 1)
console.log(`vocabulary: ${vocab.length}`)

// Sparse rows: sublinear tf × idf, L2-normalised.
const rows = chunks.map((chunk) => {
  const entries = []
  for (const [term, count] of chunk.terms) {
    const index = termIndex.get(term)
    if (index !== undefined) entries.push([index, (1 + Math.log(count)) * idf[index]])
  }
  const n = Math.sqrt(entries.reduce((sum, [, value]) => sum + value * value, 0)) || 1
  return entries.map(([index, value]) => [index, value / n])
})

// Randomized SVD of the chunk × term matrix (LSA): Q spans A·Ω, refined by two power iterations.
const k = LSA_DIMENSIONS
const oversample = k + 10
const random = rng(SEED)
const multiplyA = (vectorsOverTerms) => vectorsOverTerms.map((vector) => rows.map((row) => row.reduce((sum, [index, value]) => sum + value * vector[index], 0)))
const multiplyAt = (vectorsOverChunks) => vectorsOverChunks.map((vector) => {
  const out = new Float64Array(vocab.length)
  rows.forEach((row, chunkIndex) => { const weight = vector[chunkIndex]; if (weight) for (const [index, value] of row) out[index] += value * weight })
  return Array.from(out)
})
let q = orthonormalColumns(multiplyA(Array.from({ length: oversample }, () => Array.from({ length: vocab.length }, () => random() * 2 - 1))))
for (let iteration = 0; iteration < 2; iteration++) q = orthonormalColumns(multiplyA(orthonormalColumns(multiplyAt(q))))
const b = multiplyAt(q) // rows of B = Qᵀ A, each over terms
const gram = b.map((x) => b.map((y) => dot(x, y)))
const eigen = jacobiEigen(gram).slice(0, k)
const singular = eigen.map(({ value }) => Math.sqrt(Math.max(value, 0)))
// Chunk coordinates U_A Σ = Q U Σ.
const chunkVectors = chunks.map((_, chunkIndex) => normalize(eigen.map(({ vector }, d) => vector.reduce((sum, weight, row) => sum + weight * q[row][chunkIndex], 0) * singular[d])))

// Paper vectors: mean of chunk vectors (abstract and conclusion weighted up), centred on the
// library mean. Without centring every paper leans the same way ("training, data, learning")
// and the cosine between any two papers is high.
const ROLE_WEIGHT = { abstract: 3, conclusion: 1.5, introduction: 1.2 }
const rawPaperVectors = papers.map((_, paperIndex) => {
  const sum = new Array(k).fill(0)
  chunks.forEach((chunk, chunkIndex) => {
    if (chunk.paper !== paperIndex) return
    const weight = ROLE_WEIGHT[chunk.role] ?? 1
    chunkVectors[chunkIndex].forEach((value, d) => { sum[d] += value * weight })
  })
  return normalize(sum)
})
const libraryMean = new Array(k).fill(0).map((_, d) => rawPaperVectors.reduce((sum, vector) => sum + vector[d], 0) / papers.length)
const paperVectors = rawPaperVectors.map((vector) => normalize(vector.map((value, d) => value - libraryMean[d])))
const similarity =paperVectors.map((a) => paperVectors.map((b) => dot(a, b)))

// ───────────── Relatedness: content, citation and shared references in one score ─────────────

// Direct citations between papers in the library: the cited paper's original title in one reference.
const titleTokens = papers.map((paper) => (paper.original.toLowerCase().match(/[a-z0-9]{3,}/gu) ?? []).filter((word) => !STOP_LATIN.has(word)))
const referenceEntries = papers.map((paper) => paper.references.split(/\n+/u).map((line) => line.trim()).filter((line) => line.length > 30))
const citesLibraryPaper = (line, to) => {
  const words = titleTokens[to]
  const lineWords = (line.toLowerCase().match(/[a-z0-9]{3,}/gu) ?? []).filter((word) => !STOP_LATIN.has(word))
  // Whole words only; a short title ("Deep learning") must appear as a phrase.
  if (words.length >= 4) {
    const set = new Set(lineWords)
    return words.filter((word) => set.has(word)).length / words.length >= 0.85
  }
  return words.length >= 2 && lineWords.join(' ').includes(words.join(' '))
}
const cites = papers.map(() => new Set())
const citations = []
papers.forEach((_, from) => papers.forEach((__, to) => {
  if (from !== to && referenceEntries[from].some((line) => citesLibraryPaper(line, to))) {
    cites[from].add(to)
    citations.push({ from, to })
  }
}))

// Bibliographic coupling: two papers that cite the same outside work are related. A reference is
// matched across papers by its word set (Jaccard ≥ 0.5) and, when both carry one, the same year.
const referenceTitle = (line) => line.split(/\.\s+/u)
  .map((part) => part.replace(/^\s*(?:\\?\[\d+\]|\d{1,3})\s*/u, '').trim())
  // The title is the segment with the most lower-case words (author names are capitalised) and no
  // venue or year.
  .map((part) => [part, (part.match(/(?<![A-Za-z])[a-z]{4,}/gu) ?? []).length - 2 * (part.match(/\b[A-Z]\b/gu) ?? []).length -
    (/\d{4}/u.test(part) ? 2 : 0) - (/^in\s|proceedings|conference|journal|arxiv|preprint|transactions|\bvol\b/iu.test(part) ? 8 : 0)])
  .sort((a, b) => b[1] - a[1])[0]?.[0].slice(0, 90) ?? line.slice(0, 90)
const referenceKey = (line) => ({
  words: new Set((line.toLowerCase().match(/[a-z]{3,}/gu) ?? []).filter((word) => !STOP_LATIN.has(word))),
  year: line.match(/\b(?:19|20)\d{2}\b/u)?.[0] ?? null
})
const outside = referenceEntries.map((entries) => entries
  .filter((line) => !papers.some((_, to) => citesLibraryPaper(line, to)))
  .map((line) => ({ line, ...referenceKey(line) })))
const sameWork = (a, b) => {
  if (a.year && b.year && a.year !== b.year) return false
  let shared = 0
  for (const word of a.words) if (b.words.has(word)) shared++
  return shared >= 4 && shared / (a.words.size + b.words.size - shared) >= 0.5
}
const sharedWorks = [] // { title, papers: Set }
outside.forEach((entries, paper) => entries.forEach((entry) => {
  const work = sharedWorks.find((candidate) => candidate.keys.some((key) => sameWork(key, entry)))
  if (work) { work.papers.add(paper); work.keys.push(entry) } else sharedWorks.push({ title: referenceTitle(entry.line), papers: new Set([paper]), keys: [entry] })
}))
const coCited = sharedWorks.filter((work) => work.papers.size >= 2)
// A work most of the library cites (Adam, ImageNet) says little; one only two papers share says a
// lot. Shared works are weighted like IDF and the sum is normalised as Salton's cosine.
const specificity = (cited) => Math.log(papers.length / cited) / Math.log(papers.length / 2)
const coupling = papers.map((_, i) => papers.map((__, j) => {
  if (i === j || !outside[i].length || !outside[j].length) return 0
  const shared = coCited.filter((work) => work.papers.has(i) && work.papers.has(j)).reduce((sum, work) => sum + specificity(work.papers.size), 0)
  return shared / Math.sqrt(outside[i].length * outside[j].length)
}))
// Citing a paper half the library cites (Attention Is All You Need) is weaker evidence of a shared
// topic than citing one nobody else does.
const inDegree = papers.map((_, j) => citations.filter((c) => c.to === j).length)
const citationStrength = (from, to) => (cites[from].has(to) ? 1 / Math.sqrt(inDegree[to]) : 0)

// One score per pair. Content carries most of the weight; a direct citation or a strong overlap in
// references pulls papers together even when their wording differs (a method and its application).
const WEIGHTS = { content: 0.55, citation: 0.25, references: 0.2 }
const COUPLING_FULL = 0.12 // specific shared references worth an eighth of the lists count as full overlap
const relatedness = papers.map((_, i) => papers.map((__, j) => {
  if (i === j) return null
  const content = Math.max(0, similarity[i][j])
  const citation = Math.max(citationStrength(i, j), citationStrength(j, i))
  const references = Math.min(1, coupling[i][j] / COUPLING_FULL)
  return { content, citation, references, total: WEIGHTS.content * content + WEIGHTS.citation * citation + WEIGHTS.references * references }
}))
console.log(`citations: ${citations.length}, shared outside references: ${coCited.length}`)

// ───────────── Groups: Louvain communities on the relatedness graph ─────────────
// Each paper keeps its strongest links (top 4, or any above 0.25), as the graph view shows them.
const EDGE_KEEP = 4
const edges = []
papers.forEach((_, i) => {
  const strongest = papers.map((__, j) => [j, relatedness[i][j]?.total ?? 0]).filter(([j]) => j !== i).sort((a, b) => b[1] - a[1])
  strongest.forEach(([j, weight], rank) => {
    if ((rank < EDGE_KEEP || weight >= 0.25) && weight > 0.05 && !edges.some((edge) => (edge.a === j && edge.b === i) || (edge.a === i && edge.b === j))) edges.push({ a: i, b: j, weight })
  })
})

function louvain(count, links, resolution = 1) {
  const weight = Array.from({ length: count }, () => new Map())
  for (const { a, b, w } of links) { weight[a].set(b, (weight[a].get(b) ?? 0) + w); weight[b].set(a, (weight[b].get(a) ?? 0) + w) }
  const degree = weight.map((map) => [...map.values()].reduce((s, v) => s + v, 0))
  const total = degree.reduce((s, v) => s + v, 0) / 2 || 1
  const community = Array.from({ length: count }, (_, i) => i)
  const communityDegree = degree.slice()
  let moved = true
  for (let pass = 0; moved && pass < 50; pass++) {
    moved = false
    for (let node = 0; node < count; node++) {
      const own = community[node]
      const toCommunity = new Map()
      for (const [other, w] of weight[node]) toCommunity.set(community[other], (toCommunity.get(community[other]) ?? 0) + w)
      communityDegree[own] -= degree[node]
      const gain = (target) => (toCommunity.get(target) ?? 0) - resolution * communityDegree[target] * degree[node] / (2 * total)
      let best = own
      let bestGain = gain(own)
      for (const target of toCommunity.keys()) { const g = gain(target); if (g > bestGain + 1e-12) { best = target; bestGain = g } }
      communityDegree[best] += degree[node]
      if (best !== own) { community[node] = best; moved = true }
    }
  }
  return community
}
// Louvain's local moving at several resolutions; keep the partition with the best plain modularity
// among those with 3–6 groups (a library page needs a handful of columns, not one or fourteen).
const links = edges.map(({ a, b, weight }) => ({ a, b, w: weight }))
const modularityOf = (community) => {
  const degree = papers.map((_, i) => links.filter((e) => e.a === i || e.b === i).reduce((sum, e) => sum + e.w, 0))
  const m = links.reduce((sum, e) => sum + e.w, 0) || 1
  let q = 0
  for (const e of links) if (community[e.a] === community[e.b]) q += e.w / m
  for (const id of new Set(community)) {
    const d = papers.reduce((sum, _, i) => sum + (community[i] === id ? degree[i] : 0), 0)
    q -= (d / (2 * m)) ** 2
  }
  return q
}
let communityOf = louvain(papers.length, links)
let modularity = modularityOf(communityOf)
let found = false
const resolutions = []
for (let step = 0; step <= 22; step++) {
  const resolution = 0.8 + step * 0.1
  const candidate = louvain(papers.length, links, resolution)
  const count = new Set(candidate).size
  const q = modularityOf(candidate)
  resolutions.push({ resolution: +resolution.toFixed(1), groups: count, modularity: +q.toFixed(3) })
  if (count >= 3 && count <= 6 && (!found || q > modularity)) { found = true; modularity = q; communityOf = candidate }
}
const groupsList = [...new Set(communityOf)].map((id) => papers.map((_, i) => i).filter((i) => communityOf[i] === id)).sort((a, b) => b.length - a.length || a[0] - b[0])
const groupOf = new Map(groupsList.flatMap((group, index) => group.map((paper) => [paper, index])))
console.log(`groups: ${groupsList.length}, modularity ${modularity.toFixed(3)}`)

const paperTermSets = papers.map((_, paper) => new Set(chunks.filter((chunk) => chunk.paper === paper).flatMap((chunk) => [...chunk.terms.keys()])))
// Terms used by most of the library ("训练", "数据") cannot name one topic.
const paperFrequency = (term) => paperTermSets.filter((set) => set.has(term)).length

/** Group labels: class-based TF-IDF over each group's chunks (BERTopic's c-TF-IDF). */
function labelGroups(groups, limit) {
  const of = new Map(groups.flatMap((group, index) => group.map((paper) => [paper, index])))
  const groupTerms = groups.map(() => new Map())
  for (const chunk of chunks) {
    const target = groupTerms[of.get(chunk.paper)]
    for (const [term, count] of chunk.terms) if (termIndex.has(term)) target.set(term, (target.get(term) ?? 0) + count)
  }
  const totalTerms = new Map()
  for (const map of groupTerms) for (const [term, count] of map) totalTerms.set(term, (totalTerms.get(term) ?? 0) + count)
  const averageSize = groupTerms.reduce((sum, map) => sum + [...map.values()].reduce((a, b) => a + b, 0), 0) / groups.length
  return groups.map((group, index) => {
    const map = groupTerms[index]
    const size = [...map.values()].reduce((a, b) => a + b, 0)
    // A label must be shared by the group's papers, not come from one of them.
    const spread = (term) => group.filter((paper) => paperTermSets[paper].has(term)).length
    const scored = [...map.entries()]
      .filter(([term]) => paperFrequency(term) <= Math.max(2, papers.length * 0.5))
      .filter(([term]) => group.length < 2 || spread(term) >= Math.min(2, group.length))
      .map(([term, count]) => [term, (count / size) * Math.log(1 + averageSize / totalTerms.get(term))])
      .sort((a, b) => b[1] - a[1])
    const terms = []
    for (const [term] of scored) {
      if (terms.length >= limit) break
      if (!terms.some((other) => other.includes(term) || term.includes(other))) terms.push(term)
    }
    return { id: index, papers: group, terms }
  })
}
const groups = labelGroups(groupsList, 5)
const paperTerms = labelGroups(papers.map((_, index) => [index]), 8).map((label) => label.terms)

const round = (value) => Math.round(value * 1000) / 1000
const output = {
  generatedAt: new Date().toISOString(),
  method: { chunkChars: CHUNK_CHARS, chunks: chunks.length, lsaDimensions: k, vocabulary: vocab.length, weights: WEIGHTS, couplingFull: COUPLING_FULL, modularity: round(modularity), resolutions },
  papers: papers.map((paper, index) => ({
    id: paper.id, title: paper.title, original: paper.original, group: groupOf.get(index),
    chunks: paper.chunks.length, references: referenceEntries[index].length, terms: paperTerms[index]
  })),
  // Upper triangle as a list: [i, j, total, content, citation, references].
  pairs: papers.flatMap((_, i) => papers.map((__, j) => j).filter((j) => j > i).map((j) => {
    const r = relatedness[i][j]
    return [i, j, round(r.total), round(r.content), round(r.citation), round(r.references)]
  })),
  edges: edges.map(({ a, b, weight }) => [a, b, round(weight)]),
  groups,
  citations,
  // Outside works cited by two or more library papers (drawn like Obsidian's unresolved links).
  sharedReferences: coCited.map((work) => ({ title: work.title, papers: [...work.papers] })).sort((a, b) => b.papers.length - a.papers.length)
}
writeFileSync(outPath, JSON.stringify(output))
if (htmlPath) {
  // The page embeds its data; '<' is escaped so a passage cannot close the script element.
  const template = readFileSync(new URL('./graph.html', import.meta.url), 'utf8')
  writeFileSync(htmlPath, template.replace('/*GRAPH_DATA*/', () => JSON.stringify(output).replace(/</gu, '\\u003c')))
}
console.log(`groups:\n${groups.map((group) => `  ${group.terms.join(' / ')}  ←  ${group.papers.map((index) => papers[index].title.slice(0, 16)).join('；')}`).join('\n')}`)
