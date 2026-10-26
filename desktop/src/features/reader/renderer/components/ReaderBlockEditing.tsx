import React from 'react'
import { Button } from 'antd'
import type { ReaderBlock } from '../../core/readerDocument'

/** The reader's edit layer for one view. Editing starts from a second click on the current paragraph;
 * deletion, restoring, framing and retranslation are in the right-click menus. Nothing appears on hover. */
export interface ReaderBlockEditing {
  view: 'original' | 'translated'
  save(block: ReaderBlock, markdown: string): Promise<void>
}

/** The rendered paragraph's own font, size and line height, so editing does not change how the text looks. */
export function blockTypography(block: HTMLElement | null): React.CSSProperties {
  const source = block?.querySelector<HTMLElement>('p, h1, h2, h3, h4, h5, h6, li, blockquote, td') ?? block
  if (!source) return {}
  const style = window.getComputedStyle(source)
  return { fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight, fontStyle: style.fontStyle,
    lineHeight: style.lineHeight, letterSpacing: style.letterSpacing, color: style.color, textAlign: style.textAlign as React.CSSProperties['textAlign'],
    textIndent: style.textIndent, marginTop: style.marginTop, marginBottom: style.marginBottom }
}

export function ReaderBlockEditor(props: { block: ReaderBlock; editing: ReaderBlockEditing; typography: React.CSSProperties; onClose(): void }): React.JSX.Element {
  const initial = props.block.source ?? props.block.markdown
  const [value, setValue] = React.useState(initial)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState('')
  const ref = React.useRef<HTMLTextAreaElement>(null)
  // Grow with the text; the block keeps its place in the page instead of scrolling inside a box.
  React.useLayoutEffect(() => {
    const area = ref.current
    if (!area) return
    area.style.height = '0px'
    area.style.height = `${area.scrollHeight}px`
  }, [value, props.typography])
  React.useEffect(() => { ref.current?.focus({ preventScroll: true }) }, [])
  const save = async (): Promise<void> => {
    if (saving) return
    if (!value.trim()) { setError('段落不能为空；要去掉整段请用「删除此段」'); return }
    if (value === initial) { props.onClose(); return }
    setSaving(true); setError('')
    try { await props.editing.save(props.block, value); props.onClose() }
    catch (failure) { setError(failure instanceof Error ? failure.message : '保存失败，请重试') }
    finally { setSaving(false) }
  }
  return (
    <div className="reader-block-editor" data-reader-annotation-ignore="true" onClick={event => event.stopPropagation()}>
      <textarea
        ref={ref}
        aria-label={props.editing.view === 'translated' ? '编辑译文段落' : '编辑原文段落'}
        value={value}
        spellCheck={false}
        style={props.typography}
        onChange={event => setValue(event.target.value)}
        onKeyDown={event => {
          // Reader shortcuts (Ctrl+W, arrows, Esc) must not act while typing.
          event.stopPropagation()
          if (event.key === 'Escape') { event.preventDefault(); props.onClose() }
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void save() }
        }}
      />
      <div className="reader-block-editor-footer">
        {error ? <span role="alert">{error}</span> : <span>Ctrl+Enter 保存，Esc 取消</span>}
        <Button size="small" onClick={props.onClose} disabled={saving}>取消</Button>
        <Button size="small" type="primary" loading={saving} onClick={() => void save()}>保存</Button>
      </div>
    </div>
  )
}
