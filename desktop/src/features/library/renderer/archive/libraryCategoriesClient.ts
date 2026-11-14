import type { LibraryCategories, LibraryCategoriesPage } from '../../contract/libraryCategories'

/**
 * Reads every page of the current categories revision. If the library changes between pages the
 * revision changes too, and reading starts over (at most three times).
 */
export async function loadLibraryCategories(read: (request: { after?: number }) => Promise<LibraryCategoriesPage> = (request) => window.copilotix.libraryCategories(request)): Promise<LibraryCategories> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let page = await read({})
    const revision = page.revision
    const { categories } = page
    const items = [...page.items]
    while (page.next !== null && page.revision === revision) {
      page = await read({ after: page.next })
      items.push(...page.items)
    }
    if (page.revision !== revision) continue
    return {
      revision,
      categories: categories.map((category, index) => ({
        ...category,
        paperIds: items.filter((item) => item.category === index).sort((a, b) => a.rank - b.rank).map((item) => item.documentId)
      }))
    }
  }
  throw new Error('文库分类在读取过程中持续变化')
}
