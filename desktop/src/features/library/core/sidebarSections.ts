/**
 * The Lite sidebar's sections: pinned papers first, then one section per content category
 * (contract/libraryCategories.ts) with the papers pinned inside it on top. Papers the categories do
 * not know yet (imported since they were computed) wait in their own section at the top.
 */
export interface SidebarPaper {
  id: string
  createdAt: string
}

export interface SidebarPins {
  /** Shown above every section, in the order they were pinned. */
  global: readonly string[]
  /** Kept first inside their own category, in the order they were pinned. */
  group: readonly string[]
}

export interface SidebarSection<Paper> {
  /** Stable across recomputed categories (their ids follow membership), so collapsing survives them. */
  key: string
  name: string
  papers: Paper[]
  kind: 'pinned' | 'new' | 'category'
}

export const PINNED_SECTION = '置顶'
export const NEW_SECTION = '未分组'

export function sidebarSections<Paper extends SidebarPaper>(
  documents: readonly Paper[],
  categories: ReadonlyArray<{ name: string; paperIds: readonly string[] }> | null,
  pins: SidebarPins
): SidebarSection<Paper>[] {
  const byId = new Map(documents.map((paper) => [paper.id, paper] as const))
  const newestFirst = (a: Paper, b: Paper): number => b.createdAt.localeCompare(a.createdAt)
  const sections: SidebarSection<Paper>[] = []
  const pinned = pins.global.map((id) => byId.get(id)).filter((paper): paper is Paper => Boolean(paper))
  if (pinned.length) sections.push({ key: 'pinned', name: PINNED_SECTION, papers: pinned, kind: 'pinned' })
  const placed = new Set(pinned.map((paper) => paper.id))
  const groupPinOrder = new Map(pins.group.map((id, index) => [id, index] as const))
  const ordered = (papers: Paper[]): Paper[] => papers.sort((a, b) => {
    const pinA = groupPinOrder.get(a.id), pinB = groupPinOrder.get(b.id)
    if (pinA !== undefined || pinB !== undefined) return (pinA ?? Infinity) - (pinB ?? Infinity)
    return newestFirst(a, b)
  })
  const grouped: SidebarSection<Paper>[] = []
  for (const category of categories ?? []) {
    const papers = category.paperIds.map((id) => byId.get(id)).filter((paper): paper is Paper => Boolean(paper) && !placed.has(paper!.id))
    for (const paper of papers) placed.add(paper.id)
    if (papers.length) grouped.push({ key: `category:${category.name}`, name: category.name, papers: ordered(papers), kind: 'category' })
  }
  const rest = documents.filter((paper) => !placed.has(paper.id))
  if (rest.length) sections.push({ key: 'new', name: NEW_SECTION, papers: ordered([...rest]), kind: 'new' })
  return [...sections, ...grouped]
}

/** Pinning globally moves a paper out of its group's pins; unpinning leaves it where it was. */
export function togglePin(pins: SidebarPins, documentId: string, scope: 'global' | 'group'): SidebarPins {
  const other = scope === 'global' ? 'group' : 'global'
  const current = pins[scope]
  if (current.includes(documentId)) return { ...pins, [scope]: current.filter((id) => id !== documentId) }
  return { ...pins, [scope]: [...current, documentId], [other]: pins[other].filter((id) => id !== documentId) } as SidebarPins
}

/** Pins of papers that no longer exist are dropped. */
export function prunePins(pins: SidebarPins, ids: ReadonlySet<string>): SidebarPins {
  const global = pins.global.filter((id) => ids.has(id))
  const group = pins.group.filter((id) => ids.has(id))
  return global.length === pins.global.length && group.length === pins.group.length ? pins : { global, group }
}
