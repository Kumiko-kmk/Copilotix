/** Share the lazy import with the archive's warm-up without mounting a second reader. */
let pending: Promise<typeof import('./pages/ReaderPage')> | undefined
let loaded: typeof import('./pages/ReaderPage').default | undefined

export function loadReaderPage(): Promise<typeof import('./pages/ReaderPage')> {
  pending ??= import('./pages/ReaderPage').then(module => {
    loaded = module.default
    return module
  }).catch(error => {
    pending = undefined
    throw error
  })
  return pending
}

/** A warm archive entry should not flash Suspense's loading screen on its first mount. */
export function loadedReaderPage(): typeof import('./pages/ReaderPage').default | undefined {
  return loaded
}
