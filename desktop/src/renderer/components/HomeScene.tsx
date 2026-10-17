import React from 'react'
import type { DocumentSummary } from '@shared/ipcSchemas'
import { startCipherField, type CipherField, type CipherTitle } from '../homeCipher'

const NO_DOCUMENTS: readonly DocumentSummary[] = []
/** Translated titles by `id:updatedAt`; null when a paper has none. Only titles are kept. */
const translatedTitles = new Map<string, string | null>()
const TRANSLATED_LIMIT = 10
const titleKey = (document: DocumentSummary): string => `${document.id}:${document.updatedAt}`

function cipherTitles(documents: readonly DocumentSummary[]): CipherTitle[] {
  return documents.map((document) => {
    const original = document.displayName.replace(/\.pdf\s*$/iu, '').trim()
    const translated = translatedTitles.get(titleKey(document))
    return { texts: translated && translated !== original ? [original, translated] : [original] }
  })
}

/**
 * Decorative backdrop behind the new-parse hero: the cipher field (homeCipher.ts). Waves reveal
 * library papers by their original or translated title. Translated titles are read once the page
 * is idle, from the most recent finished papers only.
 */
export function HomeBackdrop(props: { documents?: readonly DocumentSummary[] }): React.JSX.Element {
  const documents = props.documents ?? NO_DOCUMENTS
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const fieldRef = React.useRef<CipherField | null>(null)
  const [translatedRevision, setTranslatedRevision] = React.useState(0)
  // The revision marks new translated titles in the module cache.
  const titles = React.useMemo(() => cipherTitles(documents), [documents, translatedRevision])
  const titlesRef = React.useRef(titles)
  titlesRef.current = titles

  React.useEffect(() => {
    const canvas = canvasRef.current
    const page = canvas?.closest<HTMLElement>('.new-parse-page') ?? canvas?.parentElement
    if (!canvas || !page) return
    const field = startCipherField(canvas, page, page.querySelector<HTMLElement>('.copilotix-wordmark'), titlesRef.current)
    fieldRef.current = field
    return () => {
      field?.dispose()
      fieldRef.current = null
    }
  }, [])
  React.useEffect(() => { fieldRef.current?.setTitles(titles) }, [titles])

  React.useEffect(() => {
    const read = window.copilotix?.getDocument
    const wanted = documents
      .filter((document) => document.workflow.status === 'completed' || document.workflow.status === 'partial')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, TRANSLATED_LIMIT)
      .filter((document) => !translatedTitles.has(titleKey(document)))
    if (!read || !wanted.length) return
    let cancelled = false
    const timer = window.setTimeout(() => void (async () => {
      const { archiveTranslatedTitle } = await import('@shared/paperProfile')
      for (const document of wanted) {
        if (cancelled) return
        try {
          translatedTitles.set(titleKey(document), archiveTranslatedTitle((await read(document.id)).translatedMarkdown) || null)
        } catch {
          translatedTitles.set(titleKey(document), null)
        }
        if (cancelled) return
        setTranslatedRevision((revision) => revision + 1)
        await new Promise((resolve) => window.setTimeout(resolve, 400))
      }
    })(), 1500)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [documents])

  return (
    <div className="home-backdrop" aria-hidden="true">
      <canvas ref={canvasRef} className="home-cipher" />
      <div className="paper-grain" />
    </div>
  )
}

/** Upload illustration: two stacked sheets that fan out on hover and lift while dragging. */
export function UploadGlyph(): React.JSX.Element {
  return (
    <span className="upload-glyph" aria-hidden="true">
      <svg viewBox="0 0 48 48" width="48" height="48">
        <g className="upload-glyph-back">
          <rect x="11" y="7" width="24" height="31" rx="4" />
        </g>
        <g className="upload-glyph-front">
          <path d="M15 11h14l8 8v20a4 4 0 0 1-4 4H15a4 4 0 0 1-4-4V15a4 4 0 0 1 4-4Z" />
          <path className="upload-glyph-fold" d="M29 11v5a3 3 0 0 0 3 3h5" />
          <path className="upload-glyph-line" d="M17 26h14M17 31h14M17 36h8" />
        </g>
      </svg>
    </span>
  )
}
