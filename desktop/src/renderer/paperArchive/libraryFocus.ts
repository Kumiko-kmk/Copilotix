/**
 * A paper the library should select when it next opens, such as one just imported from the home
 * page. Kept outside LibraryPage so callers do not load the Three.js scene to set it.
 */
let pendingFocus: string | null = null

export function requestLibraryFocus(documentId: string): void {
  pendingFocus = documentId
}

export function takeLibraryFocus(): string | null {
  const documentId = pendingFocus
  pendingFocus = null
  return documentId
}
