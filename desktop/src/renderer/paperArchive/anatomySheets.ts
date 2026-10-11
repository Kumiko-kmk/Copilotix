// Sheets for the taken-apart file (archiveViewer.ts): one per section of the paper. They are seen
// at card size, so type is large. The body is a placeholder until section summaries, key points
// and related figures are wired in (docs/ARCHIVE_ANATOMY_ZH.md).

const FONT = '"Microsoft YaHei UI", "PingFang SC", "Segoe UI", sans-serif'
const INK = '#2f2a24'
const MUTED = '#8a8174'
const ACCENT = '#5b58d6'
/** Same proportions as the card's window. */
export const SHEET_SIZE = { width: 1280, height: 906 }

/** One section of the paper: its number and title over demo text blocks. */
export function drawSectionSheet(index: number, total: number, title: string, paper: string): HTMLCanvasElement {
  const { width, height } = SHEET_SIZE
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { alpha: false })
  if (!context) return canvas
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, width, height)
  const margin = 84

  context.fillStyle = MUTED
  context.font = `600 22px ${FONT}`
  context.fillText(`SECTION ${pad(index + 1)}  /  ${pad(total)}`, margin, 92)
  context.textAlign = 'right'
  context.fillText(clip(context, paper, 520), width - margin, 92)
  context.textAlign = 'left'

  context.fillStyle = INK
  context.font = `300 132px ${FONT}`
  context.fillText(pad(index + 1), margin - 6, 250)
  context.font = `700 54px ${FONT}`
  context.fillText(clip(context, title, width - margin * 2 - 220), margin + 220, 238)
  // The archive's rule with its square mark.
  context.fillRect(margin, 296, width - margin * 2, 2)
  context.fillRect(margin - 16, 292, 9, 9)

  // Demo body: two columns of text blocks and a key-point box, so the layer reads as a page.
  const top = 360
  const column = (width - margin * 2 - 48) / 2
  context.fillStyle = 'rgba(47, 42, 36, 0.12)'
  for (const [x, lines] of [[margin, 9], [margin + column + 48, 5]] as const) {
    for (let line = 0; line < lines; line++) {
      const short = line === lines - 1 ? 0.55 : line % 4 === 3 ? 0.82 : 1
      context.fillRect(x, top + line * 46, column * short, 18)
    }
  }
  const box = { x: margin + column + 48, y: top + 5 * 46 + 18, width: column, height: 150 }
  context.fillStyle = 'rgba(91, 88, 214, 0.07)'
  context.fillRect(box.x, box.y, box.width, box.height)
  context.fillStyle = ACCENT
  context.fillRect(box.x, box.y, 4, box.height)
  context.font = `600 22px ${FONT}`
  context.fillText('KEY POINT  /  要点', box.x + 28, box.y + 44)
  context.fillStyle = 'rgba(91, 88, 214, 0.22)'
  context.fillRect(box.x + 28, box.y + 72, box.width * 0.78, 16)
  context.fillRect(box.x + 28, box.y + 106, box.width * 0.52, 16)

  context.fillStyle = MUTED
  context.font = `500 20px ${FONT}`
  context.fillText('DEMO · 章节摘要与要点稍后接入', margin, height - 64)
  return canvas
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** Cut `text` to `width`, ending with an ellipsis. */
function clip(context: CanvasRenderingContext2D, text: string, width: number): string {
  if (context.measureText(text).width <= width) return text
  let result = text
  while (result && context.measureText(`${result}…`).width > width) result = result.slice(0, -1)
  return `${result}…`
}
