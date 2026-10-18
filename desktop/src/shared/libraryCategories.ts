/**
 * Library categories: papers grouped by what they are about, for the 文库 columns. Computed in
 * the Utility from local text (no model call) and named from the AI file cards when papers have
 * them. Paged like every list that grows with the library (AGENTS.md §7).
 */
import { z } from 'zod'

export const LIBRARY_CATEGORY_PAGE_SIZE = 200
export const CATEGORY_NAME_MAX = 24
/** The single category of a library too small or too uniform to split. */
export const ALL_PAPERS_NAME = '全部论文'

export const libraryCategoriesRequestSchema = z.object({
  /** Offset into the membership list of the revision being read. */
  after: z.number().int().min(0).max(10_000_000).optional()
}).strict()
export type LibraryCategoriesRequest = z.infer<typeof libraryCategoriesRequestSchema>

export const libraryCategorySchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,64}$/u),
  name: z.string().trim().min(1).max(CATEGORY_NAME_MAX),
  /** Where the name came from: an AI file card's field, distinctive words, or not yet classifiable. */
  named: z.enum(['brief', 'terms', 'pending']),
  size: z.number().int().nonnegative()
}).strict()
export type LibraryCategory = z.infer<typeof libraryCategorySchema>

export const libraryCategoriesPageSchema = z.object({
  /** Changes whenever papers, their text or their file cards change; pages of one revision fit together. */
  revision: z.string().regex(/^[0-9a-f]{16}$/u),
  categories: z.array(libraryCategorySchema).max(500),
  /** Ordered by category, then by rank (most typical paper first). */
  items: z.array(z.object({
    documentId: z.uuid(),
    category: z.number().int().nonnegative(),
    rank: z.number().int().nonnegative()
  }).strict()).max(LIBRARY_CATEGORY_PAGE_SIZE),
  next: z.number().int().nonnegative().nullable()
}).strict()
export type LibraryCategoriesPage = z.infer<typeof libraryCategoriesPageSchema>

/** A whole revision, assembled from its pages by the renderer. */
export interface LibraryCategories {
  revision: string
  categories: Array<LibraryCategory & { paperIds: string[] }>
}
