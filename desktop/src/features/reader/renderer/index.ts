export { buildAnnotationDiff, replayAnnotationDiff } from './annotationMutations'
export { default as ReaderAnnotationToolbar } from './components/ReaderAnnotationToolbar'
export { useReaderNoteLayer } from './components/ReaderNotes'
export { default as SafeMarkdown, resolveAsset } from './components/SafeMarkdown'
export { buildReaderHighlightRanges, captureReaderTextSelection, clearBrowserTextSelection, collectAnnotationBlockTexts, registerReaderHighlightRanges } from './readerAnnotations'
export type { ReaderTextSelection } from './readerAnnotations'
export { loadReaderPage, loadedReaderPage } from './readerPageLoader'

/** Figure crops render with pdf.js on demand; the import stays here so importers keep it out of their chunk. */
export function loadFigureArtifacts(): Promise<typeof import('./useFigureArtifacts')> {
  return import('./useFigureArtifacts')
}
