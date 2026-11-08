import type { QueryClient } from '@tanstack/react-query'

/** Share the lazy import with the archive's warm-up without mounting a second reader. */
let pending: Promise<typeof import('./ReaderPage')> | undefined
let loaded: typeof import('./ReaderPage').default | undefined

export function loadReaderPage(): Promise<typeof import('./ReaderPage')> {
  pending ??= import('./ReaderPage').then(module => {
    loaded = module.default
    return module
  }).catch(error => {
    pending = undefined
    throw error
  })
  return pending
}

/** A warm archive entry should not flash Suspense's loading screen on its first mount. */
export function loadedReaderPage(): typeof import('./ReaderPage').default | undefined {
  return loaded
}

/**
 * Reads a paper ahead of opening it (a pointer resting on it in a list), so the click finds it
 * ready. A paper already read is left as it is; failures are dropped, the reader retries on open.
 */
export async function prefetchReaderDocument(client: QueryClient, documentId: string): Promise<void> {
  if (client.getQueryData(['document', documentId])) return
  const { readerDocumentQuery } = await import('./readerDocumentQuery')
  await client.prefetchQuery(readerDocumentQuery(documentId)).catch(() => undefined)
}
