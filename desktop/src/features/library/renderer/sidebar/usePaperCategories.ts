import React from 'react'
import type { LibraryCategories } from '../../contract/libraryCategories'
import type { DocumentSummary } from '../../contract/documentSchemas'
import { loadLibraryCategories } from '../archive/libraryCategoriesClient'

/** Long enough that an import of many papers or a parse finishing settles into one recomputation. */
const SETTLE_MS = 800

/**
 * Content categories for the sidebar, computed locally in the Utility (no model call). They are
 * read again after the papers or their status change; until the first result arrives, and when
 * reading fails, the sidebar shows papers without categories.
 */
export function usePaperCategories(documents: readonly DocumentSummary[]): LibraryCategories['categories'] | null {
  const [categories, setCategories] = React.useState<LibraryCategories['categories'] | null>(null)
  const loaded = React.useRef(false)
  // Titles do not affect categories, so renaming a paper does not recompute them.
  const fingerprint = React.useMemo(() => documents.map((paper) => `${paper.id}:${paper.workflow.status}`).sort().join('|'), [documents])
  React.useEffect(() => {
    if (!fingerprint) { setCategories(null); return }
    let cancelled = false
    const timer = window.setTimeout(() => {
      loadLibraryCategories().then((result) => { if (!cancelled) { loaded.current = true; setCategories(result.categories) } }, () => undefined)
    }, loaded.current ? SETTLE_MS : 0)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [fingerprint])
  return categories
}
