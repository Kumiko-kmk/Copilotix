import { describe, expect, it, vi } from 'vitest'
import { categoryTerms, classifyLibrary, type CategorySource } from '../src/utility/core/compute/libraryCategories'
import { LibraryCategoryService } from '../src/utility/core/libraryCategoryService'
import { loadLibraryCategories } from '../src/renderer/paperArchive/libraryCategoriesClient'
import { libraryCategoriesPageSchema, LIBRARY_CATEGORY_PAGE_SIZE, type LibraryCategoriesPage } from '../src/shared/libraryCategories'

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const TOPICS = {
  operators: '神经算子 求解 偏微分方程 傅里叶 算子学习 边界条件 网格 泛化 流体 物理信息',
  attention: '注意力 机制 序列 翻译 编码器 解码器 自注意力 位置编码 词元 语言',
  diffusion: '扩散 去噪 采样 生成模型 噪声 图像 似然 变分 马尔可夫链 先验'
} as const

function source(n: number, topic: keyof typeof TOPICS, extra = '', area: string | null = null): CategorySource {
  // Each paper repeats its topic words and adds a few of its own, as real papers do.
  return { id: id(n), createdAt: `2026-10-${String(n).padStart(2, '0')}T00:00:00.000Z`, terms: categoryTerms(`${TOPICS[topic]} ${TOPICS[topic]} ${extra} 论文${n}专有术语${n}`), area }
}

describe('library categories', () => {
  it('tokenises Chinese words and Latin words, without formulas or LaTeX commands', () => {
    const terms = categoryTerms('Transformer 使用自注意力机制。$\\mathbf{x}$ \\lambda 傅里叶神经算子')
    expect(terms.has('transformer')).toBe(true)
    expect(terms.has('注意力')).toBe(true)
    expect([...terms.keys()].some((term) => /mathbf|lambda/u.test(term))).toBe(false)
  })

  it('groups papers by content, most typical first, and names groups by shared words', () => {
    const sources = [
      ...[1, 2, 3, 4].map((n) => source(n, 'operators')),
      ...[5, 6, 7, 8].map((n) => source(n, 'attention')),
      ...[9, 10, 11, 12].map((n) => source(n, 'diffusion'))
    ]
    const categories = classifyLibrary(sources)
    expect(categories).toHaveLength(3)
    const groupOf = (n: number) => categories.findIndex((category) => category.paperIds.includes(id(n)))
    expect(new Set([1, 2, 3, 4].map(groupOf)).size).toBe(1)
    expect(new Set([5, 6, 7, 8].map(groupOf)).size).toBe(1)
    expect(groupOf(1)).not.toBe(groupOf(5))
    expect(categories.every((category) => category.named === 'terms' && category.name.length <= 24)).toBe(true)
    expect(new Set(categories.map((category) => category.name)).size).toBe(3)
  })

  it('names a group after its file cards when they have one, and keeps unreadable papers aside', () => {
    const sources = [
      ...[1, 2, 3].map((n) => source(n, 'operators', '', n === 2 ? '神经算子与偏微分方程' : null)),
      ...[4, 5, 6].map((n) => source(n, 'attention')),
      { id: id(7), createdAt: '2026-10-07T00:00:00.000Z', terms: null, area: null }
    ]
    const categories = classifyLibrary(sources)
    expect(categories.find((category) => category.paperIds.includes(id(1)))).toMatchObject({ name: '神经算子与偏微分方程', named: 'brief' })
    expect(categories.at(-1)).toMatchObject({ id: 'pending', name: '待分类', named: 'pending', paperIds: [id(7)] })
  })

  it('keeps a tiny library in one 全部论文 category, newest first like the interim view', () => {
    const categories = classifyLibrary([source(1, 'operators', '', '神经算子'), source(2, 'attention')])
    expect(categories).toHaveLength(1)
    expect(categories[0]).toMatchObject({ name: '全部论文', paperIds: [id(2), id(1)] })
  })

  it('pages one revision and re-reads only papers whose text changed', async () => {
    const summaries = Array.from({ length: 450 }, (_, index) => ({ id: id(index + 1), createdAt: '2026-10-01T00:00:00.000Z' }))
    const revisions = new Map(summaries.map((summary) => [summary.id, 'r1']))
    const store = {
      categoryMeta: vi.fn(async (documentId: string) => ({ revision: revisions.get(documentId)!, readable: true, area: null })),
      categoryText: vi.fn(async (documentId: string) => TOPICS[(['operators', 'attention', 'diffusion'] as const)[Number(documentId.slice(-3)) % 3]!] + documentId)
    }
    const repository = { listDocumentSummaries: () => summaries as never }
    const service = new LibraryCategoryService(() => store, () => repository)
    const signal = new AbortController().signal
    const first = await service.page(0, signal)
    expect(libraryCategoriesPageSchema.parse(first)).toEqual(first)
    expect(first.items).toHaveLength(LIBRARY_CATEGORY_PAGE_SIZE)
    const second = await service.page(first.next!, signal)
    const third = await service.page(second.next!, signal)
    expect(third.next).toBeNull()
    expect([...first.items, ...second.items, ...third.items].map((item) => item.documentId).sort()).toEqual(summaries.map((summary) => summary.id).sort())
    expect(store.categoryText).toHaveBeenCalledTimes(450)
    revisions.set(id(1), 'r2')
    const changed = await service.page(0, signal)
    expect(store.categoryText).toHaveBeenCalledTimes(451)
    expect(changed.revision).not.toBe(first.revision)
  })

  it('assembles all pages on the renderer and restarts when the revision changes midway', async () => {
    const page = (revision: string, items: LibraryCategoriesPage['items'], next: number | null): LibraryCategoriesPage => ({
      revision, next, items, categories: [{ id: 'c-a', name: '甲', named: 'terms', size: 2 }]
    })
    const read = vi.fn()
      .mockResolvedValueOnce(page('aaaaaaaaaaaaaaaa', [{ documentId: id(2), category: 0, rank: 1 }], 1))
      .mockResolvedValueOnce(page('bbbbbbbbbbbbbbbb', [], null))
      .mockResolvedValueOnce(page('bbbbbbbbbbbbbbbb', [{ documentId: id(2), category: 0, rank: 1 }], 1))
      .mockResolvedValueOnce(page('bbbbbbbbbbbbbbbb', [{ documentId: id(1), category: 0, rank: 0 }], null))
    const result = await loadLibraryCategories(read)
    expect(result.revision).toBe('bbbbbbbbbbbbbbbb')
    expect(result.categories[0]!.paperIds).toEqual([id(1), id(2)])
  })
})
