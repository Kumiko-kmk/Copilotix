// Library map prototype: groups a folder of parsed papers into topics and lays them out as a map.
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
const QUERY_VOCAB = 5000
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
// Term loadings V = Bᵀ U Σ⁻¹ and chunk coordinates U_A Σ = Q U Σ.
const termLoadings = eigen.map(({ vector }, d) => {
  const column = new Float64Array(vocab.length)
  vector.forEach((weight, row) => { if (weight) b[row].forEach((value, index) => { column[index] += value * weight }) })
  return Array.from(column, (value) => value / (singular[d] || 1))
})
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

// Agglomerative clustering (average linkage, cosine distance); k chosen by silhouette.
function agglomerate(count) {
  let groups = papers.map((_, index) => [index])
  const distance = (a, b) => { let sum = 0; for (const i of a) for (const j of b) sum += 1 - similarity[i][j]; return sum / (a.length * b.length) }
  while (groups.length > count) {
    let best = [0, 1, Infinity]
    for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
      const d = distance(groups[i], groups[j])
      if (d < best[2]) best = [i, j, d]
    }
    groups[best[0]] = groups[best[0]].concat(groups[best[1]])
    groups.splice(best[1], 1)
  }
  return groups
}
function silhouette(groups) {
  const label = new Map(groups.flatMap((group, index) => group.map((paper) => [paper, index])))
  let total = 0
  for (const [paper, own] of label) {
    const mean = (group) => group.filter((other) => other !== paper).reduce((sum, other) => sum + 1 - similarity[paper][other], 0) / Math.max(1, group.filter((other) => other !== paper).length)
    const a = groups[own].length > 1 ? mean(groups[own]) : 0
    const b = Math.min(...groups.filter((_, index) => index !== own).map(mean))
    total += groups[own].length > 1 ? (b - a) / Math.max(a, b) : 0
  }
  return total / papers.length
}
// Two levels from one dendrogram: islands (the best silhouette) and regions (a few broad topics
// for the library's columns). Average linkage merges in a fixed order, so regions are unions of
// islands.
let islands = null
let bestScore = -Infinity
const tried = []
for (let count = 3; count <= Math.max(3, Math.floor(papers.length / 2)); count++) {
  const candidate = agglomerate(count)
  const score = silhouette(candidate)
  tried.push({ k: count, silhouette: +score.toFixed(3) })
  if (score > bestScore) { bestScore = score; islands = candidate }
}
const regionCount = Math.max(2, Math.min(islands.length - 1, Math.round(Math.sqrt(papers.length / 1.5))))
const regions = agglomerate(regionCount)
for (const level of [islands, regions]) level.sort((a, b) => b.length - a.length || a[0] - b[0])
console.log('silhouette by k:', tried, `→ ${islands.length} islands, ${regions.length} regions`)

const paperTermSets = papers.map((_, paper) => new Set(chunks.filter((chunk) => chunk.paper === paper).flatMap((chunk) => [...chunk.terms.keys()])))
// Terms used by most of the library ("训练", "数据") cannot name one topic.
const paperFrequency = (term) => paperTermSets.filter((set) => set.has(term)).length

/** Topic labels: class-based TF-IDF over each group's chunks (BERTopic's c-TF-IDF). */
function labelGroups(groups, limit) {
  const groupOf = new Map(groups.flatMap((group, index) => group.map((paper) => [paper, index])))
  const groupTerms = groups.map(() => new Map())
  for (const chunk of chunks) {
    const target = groupTerms[groupOf.get(chunk.paper)]
    for (const [term, count] of chunk.terms) if (termIndex.has(term)) target.set(term, (target.get(term) ?? 0) + count)
  }
  const totalTerms = new Map()
  for (const map of groupTerms) for (const [term, count] of map) totalTerms.set(term, (totalTerms.get(term) ?? 0) + count)
  const averageSize = groupTerms.reduce((sum, map) => sum + [...map.values()].reduce((a, b) => a + b, 0), 0) / groups.length
  return groups.map((group, index) => {
    const map = groupTerms[index]
    const size = [...map.values()].reduce((a, b) => a + b, 0)
    // A label must be shared by the topic's papers, not come from one of them.
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
const topics = labelGroups(islands, 6)
// Each paper's own distinctive terms, used to explain why two papers sit together.
const paperTerms = labelGroups(papers.map((_, index) => [index]), 8).map((label) => label.terms)
const regionTopics = labelGroups(regions, 5).map((region) => ({ ...region, islands: topics.filter((island) => island.papers.every((paper) => region.papers.includes(paper))).map((island) => island.id) }))
const groupOf = new Map(islands.flatMap((group, index) => group.map((paper) => [paper, index])))
const regionOf = new Map(regions.flatMap((group, index) => group.map((paper) => [paper, index])))

// Citations between papers in the library: the cited paper's original title inside one reference.
const titleTokens = papers.map((paper) => (paper.original.toLowerCase().match(/[a-z0-9]{3,}/gu) ?? []).filter((word) => !STOP_LATIN.has(word)))
const citations = []
papers.forEach((paper, from) => {
  const referenceLines = paper.references.toLowerCase().split(/\n+/u).filter((line) => line.length > 20)
  papers.forEach((_, to) => {
    if (from === to || titleTokens[to].length < 2) return
    // Whole words only; a short title ("Deep learning") must appear as a phrase.
    const words = titleTokens[to]
    const phrase = words.join(' ')
    const hit = referenceLines.some((line) => {
      const lineWords = new Set(line.match(/[a-z0-9]{3,}/gu) ?? [])
      return words.length >= 4
        ? words.filter((word) => lineWords.has(word)).length / words.length >= 0.85
        : (line.match(/[a-z0-9]{3,}/gu) ?? []).filter((word) => !STOP_LATIN.has(word)).join(' ').includes(phrase)
    })
    if (hit) citations.push({ from, to })
  })
})
console.log(`citations: ${citations.length}`)

// Cross-paper chunk neighbours: what RAG would retrieve from other papers for each chunk.
const chunkNeighbours = chunkVectors.map((vector, index) => chunkVectors
  .map((other, otherIndex) => [otherIndex, chunks[otherIndex].paper !== chunks[index].paper ? dot(vector, other) : -1])
  .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([otherIndex, score]) => [otherIndex, +score.toFixed(3)]))

// Query projection for the page: top terms by document frequency with their LSA loadings.
const queryTerms = vocab.map((term, index) => [term, index]).sort((a, b) => df.get(b[0]) - df.get(a[0])).slice(0, QUERY_VOCAB)
const round = (value) => Math.round(value * 1000) / 1000

const output = {
  generatedAt: new Date().toISOString(),
  method: { chunkChars: CHUNK_CHARS, lsaDimensions: k, vocabulary: vocab.length, silhouette: tried, islands: islands.length, regions: regions.length },
  papers: papers.map((paper, index) => ({
    id: paper.id, title: paper.title, original: paper.original, topic: groupOf.get(index), region: regionOf.get(index), bytes: paper.bytes,
    chunks: paper.chunks.length, terms: paperTerms[index],
    vector: paperVectors[index].map(round)
  })),
  similarity: similarity.map((row) => row.map(round)),
  topics,
  regions: regionTopics,
  citations,
  chunks: chunks.map((chunk, index) => ({
    paper: chunk.paper, role: chunk.role, section: chunk.section.slice(0, 80),
    text: chunk.text.slice(0, 220), vector: chunkVectors[index].map(round), neighbours: chunkNeighbours[index]
  })),
  query: {
    terms: queryTerms.map(([term]) => term),
    idf: queryTerms.map(([, index]) => round(idf[index])),
    loadings: queryTerms.map(([, index]) => termLoadings.map((column) => round(column[index])))
  }
}
writeFileSync(outPath, JSON.stringify(output))
if (htmlPath) {
  // The page embeds its data; '<' is escaped so a passage cannot close the script element.
  const template = readFileSync(new URL('./map.html', import.meta.url), 'utf8')
  writeFileSync(htmlPath, template.replace('/*MAP_DATA*/', () => JSON.stringify(output).replace(/</gu, '\\u003c')))
}
console.log(`topics:\n${topics.map((topic) => `  ${topic.terms.join(' / ')}  ←  ${topic.papers.map((index) => papers[index].title).join('；')}`).join('\n')}`)
