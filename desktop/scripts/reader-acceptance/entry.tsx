import React from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/app/renderer/taiwan-kai.css'
import { ConfigProvider } from 'antd'
import { FilePdfOutlined, FileTextOutlined } from '@ant-design/icons'
import PdfPane from '../../src/features/reader/renderer/components/PdfPane'
import MarkdownPane from '../../src/features/reader/renderer/components/MarkdownPane'
import ReaderWorkbench from '../../src/features/reader/renderer/components/ReaderWorkbench'
import { defaultReaderLayout, hideView, listGroups } from '../../src/features/reader/renderer/readerLayout'
import { createScrollSyncHub } from '../../src/features/reader/renderer/readerScrollSync'
import { buildReaderBase, buildTranslatedBase } from '../../src/features/document/core/readerDocument'
import { buildReaderFigureGeometries, projectReaderFigureGroups } from '../../src/features/document/core/readerFigureGroups'
import { readerPerformanceSnapshot, readerFootprint } from '../../src/features/reader/renderer/readerPerformance'
import type { TranslatedMarkdownBlock } from '../../src/features/document/contract/translation'
import type { BlockMapping } from '../../src/features/parsing/contract/blocks'
import type { BlockSelection, HighlightColor, ReaderAnnotation } from '../../src/features/reader/contract/readerTypes'
import '../../src/app/renderer/styles.css'
import './shell.css'

const metrics = { resourcesMs: 0, modelMs: 0, firstPdfMs: 0, markdownReadyMs: 0, translatedReadyMs: 0 }
Object.assign(window, { readerAcceptance: { metrics, snapshot: readerPerformanceSnapshot, footprint: () => readerFootprint(document) } })
const base = 'reader-asset://app/paper/'
async function boot() {
  const [markdown, mappingFile, layoutJson, translatedMarkdown, manifest] = await Promise.all([
    fetch(base + 'full.md').then(r => { if (!r.ok) throw new Error('原文讀取失敗'); return r.text() }),
    fetch(base + 'block_list.json').then(r => { if (!r.ok) throw new Error('對映讀取失敗'); return r.json() }),
    fetch(base + 'layout.json').then(r => { if (!r.ok) throw new Error('版面讀取失敗'); return r.text() }),
    fetch(base + 'full.zh-CN.md').then(r => { if (!r.ok) throw new Error('譯文讀取失敗'); return r.text() }),
    fetch(base + 'translation.manifest.json').then(r => { if (!r.ok) throw new Error('譯文對映讀取失敗'); return r.json() })
  ])
  metrics.resourcesMs = performance.now()
  const mappings: BlockMapping[] = mappingFile.mappings
  const readerBase = buildReaderBase(markdown, mappings)
  const blocks = readerBase.original
  const translations: TranslatedMarkdownBlock[] = manifest.blocks
  if (!Array.isArray(translations) || translations.length !== readerBase.content.length || !manifest.sourceVersion) throw new Error('譯文來源資訊不完整')
  await Promise.all(translations.map(async block => {
    const source = readerBase.content[block.sourceIndex ?? -1]
    if (!source) throw new Error('譯文來源段落不存在')
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source.markdown))
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
    if (hash !== block.sourceHash) throw new Error('譯文與當前原文不匹配')
  }))
  const translated = buildTranslatedBase(readerBase, translatedMarkdown, translations, mappings)
  if (!translated.indexed) throw new Error('譯文來源對映不完整')
  const translatedBlocks = translated.blocks
  const translatedFigures = projectReaderFigureGroups(buildReaderFigureGeometries(mappings, layoutJson), translatedBlocks)
  const figures = projectReaderFigureGroups(buildReaderFigureGeometries(mappings, layoutJson), blocks)
  metrics.modelMs = performance.now() - metrics.resourcesMs
  const title = blocks.find(block => /^#\s/.test(block.markdown))?.markdown.replace(/^#+\s*/, '').replace(/\n/g, ' ') || 'original.pdf'
  function Reader() {
    const [layout, setLayout] = React.useState(() => hideView(defaultReaderLayout(), 'chat'))
    const [focus, setFocus] = React.useState<string | null>('g1')
    const [selection, setSelection] = React.useState<BlockSelection | null>(null)
    const [annotations, setAnnotations] = React.useState<ReaderAnnotation[]>([])
    const [translatedAnnotations, setTranslatedAnnotations] = React.useState<ReaderAnnotation[]>([])
    const positions = React.useRef({ original: 0, translated: 0 })
    const [color, setColor] = React.useState<HighlightColor>('yellow')
    const [sync] = React.useState(createScrollSyncHub)
    React.useEffect(() => {
      sync.setParticipants(listGroups(layout.root).map(group => group.active).filter(view => layout.synced.includes(view)))
    }, [layout, sync])
    React.useEffect(() => () => sync.dispose(), [sync])
    React.useEffect(() => {
      let frame = 0
      const sample = () => {
        if (readerPerformanceSnapshot()['pdf-render'].count) metrics.firstPdfMs ||= performance.now()
        else frame = requestAnimationFrame(sample)
      }
      frame = requestAnimationFrame(sample)
      return () => cancelAnimationFrame(frame)
    }, [])
    return <ConfigProvider theme={{ token: { colorPrimary: '#6254e8', borderRadius: 4 } }}>
      <main className="acceptance-shell"><header className="acceptance-title">{title}</header>
      <ReaderWorkbench layout={layout} onLayoutChange={setLayout} focusedGroupId={focus} onFocusGroup={setFocus} specs={{
        pdf: { label: 'PDF', icon: <FilePdfOutlined />, keepMounted: true, render: context => <PdfPane
          url={base + 'original.pdf'} mappings={mappings} selection={selection} onSelect={setSelection}
          toolbarHost={context.actionsHost} scrollSync={sync.channel('pdf')} /> },
        original: { label: '原文', icon: <FileTextOutlined />, render: context => <MarkdownPane active={context.active}
          blocks={blocks} assetBaseUrl={base} pdfUrl={base + 'original.pdf'} figureGroups={figures} taskId="reader-acceptance"
          initialScrollTop={positions.current.original} onScrollTopChange={top => { positions.current.original = top }}
          view="original" annotations={annotations} highlightColor={color} onHighlightColorChange={setColor}
          onReplaceAnnotations={async next => setAnnotations(next)} selection={selection} onSelect={setSelection}
          scrollSync={sync.channel('original')} onRenderReady={() => { metrics.markdownReadyMs ||= performance.now() }} /> },
        translated: { label: '譯文', icon: <FileTextOutlined />, render: context => <MarkdownPane active={context.active}
          blocks={translatedBlocks} assetBaseUrl={base} pdfUrl={base + 'original.pdf'} figureGroups={translatedFigures} taskId="reader-acceptance"
          initialScrollTop={positions.current.translated} onScrollTopChange={top => { positions.current.translated = top }}
          view="translated" annotations={translatedAnnotations} highlightColor={color} onHighlightColorChange={setColor}
          onReplaceAnnotations={async next => setTranslatedAnnotations(next)} selection={selection} onSelect={setSelection}
          scrollSync={sync.channel('translated')} onRenderReady={() => { metrics.translatedReadyMs ||= performance.now() }} /> }
      }} />
      </main>
    </ConfigProvider>
  }
  createRoot(document.getElementById('root')!).render(<Reader />)
}
void boot().catch(error => { document.getElementById('root')!.textContent = `閱讀器載入失敗：${String(error)}` })
