import React from 'react'
import type { ReaderFigureGroup } from '@shared/readerFigureGroups'
import { setFigureDisplayChoice } from '../readerFigureDisplay'

/**
 * Click to show a multi-panel figure as its PDF crop or as the parsed panels; the choice is kept
 * per figure in the paper's folder. Choosing what the automatic grouping would show clears it.
 */
export default function ReaderFigureDisplayToggle(props: { group: ReaderFigureGroup }): React.JSX.Element | null {
  const { group } = props
  const [busy, setBusy] = React.useState(false)
  const display = group.display
  if (!display || (group.assetSources.length < 2 && !display.choice)) return null
  const showingPdf = group.status === 'complete'
  const next = showingPdf ? 'parsed' : 'pdf'
  const automatic = display.automatic === 'complete' ? 'pdf' : 'parsed'
  return (
    <button type="button" className="reader-figure-action" data-reader-annotation-ignore="true" disabled={busy}
      onClick={event => {
        event.stopPropagation()
        setBusy(true)
        void setFigureDisplayChoice(display.documentId, group.id, next === automatic ? null : next)
          .catch(() => undefined)
          .finally(() => setBusy(false))
      }}>
      {showingPdf ? '以解析子图显示' : '以 PDF 原图显示'}
    </button>
  )
}
