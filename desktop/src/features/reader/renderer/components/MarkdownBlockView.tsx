import SafeMarkdown from './SafeMarkdown'
import React from 'react'
import type { ReaderBlock } from '../../core/readerDocument'
import type { BlockSelection } from '@shared/types'
import ReaderFigureSnapshot, { type FigureRenderState } from './ReaderFigureSnapshot'
import ReaderFigureMosaic from './ReaderFigureMosaic'
import { isEditableTarget } from './markdownPaneDom'
import type { FigureMosaic } from '../readerFigureMosaic'
import type { ReaderFigureGroup } from '../../core/readerFigureGroups'
import type { ReaderNote } from '../../contract/readerNotes'

/** One rendered Markdown block of the reader (text, table, formula or figure group) with its overlays. */

/** Adds a figure to the chat composer. `blocked` explains why the current model cannot take images. */
export interface ReaderFigureChat {
  blocked: string | null
  onAdd(group: ReaderFigureGroup): void
}

export const NO_READY_FIGURES: ReadonlySet<string> = new Set()
export const NO_NOTES: readonly ReaderNote[] = []
export const NO_MOSAICS: ReadonlyMap<string, FigureMosaic> = new Map()

export const MarkdownBlockView = React.memo(function MarkdownBlockView(props: {
  block: ReaderBlock
  referenceSection: boolean
  active: boolean
  assetBaseUrl: string
  pdfUrl?: string
  figureGroups?: ReaderFigureGroup[]
  readyFigureIds: ReadonlySet<string>
  figureMosaics: ReadonlyMap<string, FigureMosaic>
  onFigureStateChange(id: string, state: FigureRenderState): void
  /** Edit in place: offered on a single click on the text of the already current paragraph. */
  onEditRequest?(annotationKey: string, element: HTMLElement, clicks: number): void
  /** Right click; a text selection keeps the system menu (copy). */
  onBlockMenu?(block: ReaderBlock, figures: ReaderFigureGroup[], x: number, y: number): void
  /** Replaces the rendered text while the block is edited. */
  editor?: React.ReactNode
  blockIndex: number
  onFigureRendered(): void
  onSelect(selection: BlockSelection): void
}): React.JSX.Element {
  if (props.block.role === 'page-divider') {
    return (
      <div
        className="reader-page-divider"
        data-reader-role="page-divider"
        data-page-index={props.block.pageIndex}
      >
        <span>{props.block.text}</span>
      </div>
    )
  }

  const supplemental = props.block.role !== 'content'
  if (supplemental) {
    return (
      <div
        data-reader-role={props.block.role}
        data-annotation-block-key={props.block.annotationKey}
        data-page-index={props.block.pageIndex}
        className={'markdown-supplemental markdown-supplemental-' + props.block.role}
        data-boxed={props.block.boxed}
        onContextMenu={props.onBlockMenu ? (event) => {
          if (window.getSelection() && !window.getSelection()!.isCollapsed) return
          event.preventDefault()
          props.onBlockMenu!(props.block, [], event.clientX, event.clientY)
        } : undefined}
      >
        <SafeMarkdown markdown={props.block.text ?? ''} assetBaseUrl={props.assetBaseUrl} />
      </div>
    )
  }

  const readyGroups = props.figureGroups?.filter(group => group.status === 'complete' && props.readyFigureIds.has(group.id)) ?? []
  const navigationMappingIds = [...new Set([...readyGroups.filter(group => group.ownerBlockIndex === props.blockIndex).flatMap(group => group.mappingIds),
    ...props.block.mappingIds.filter(id => !readyGroups.some(group => group.mappingIds.includes(id)))])]

  return (
    <div
      data-block-ids={navigationMappingIds.join(' ')}
      data-reader-block-index={props.blockIndex}
      data-mapping-ids={props.block.mappingIds.join(' ')}
      data-annotation-block-key={props.block.annotationKey}
      data-reader-role={props.block.role}
      data-fallback-provider={props.block.fallbackProvider}
      data-source-changed={props.block.sourceChanged ? '' : undefined}
      data-stale={props.block.sourceChanged || props.block.edit?.stale ? '' : undefined}
      data-edited={props.block.edit?.edited || undefined}
      data-editing={props.editor ? true : undefined}
      data-boxed={props.block.boxed}
      className={'markdown-block' + (props.active ? ' active' : '') + (props.referenceSection ? ' reader-references' : '')}
      onContextMenu={props.onBlockMenu ? (event) => {
        if (window.getSelection() && !window.getSelection()!.isCollapsed) return
        event.preventDefault()
        const owned = props.figureGroups?.filter(group => group.ownerBlockIndex === props.blockIndex) ?? []
        props.onBlockMenu!(props.block, owned.length ? owned : props.figureGroups ?? [], event.clientX, event.clientY)
      } : undefined}
      onClick={(event) => {
        if (window.getSelection() && !window.getSelection()!.isCollapsed) return
        if (props.active && props.onEditRequest && props.block.annotationKey && isEditableTarget(event.target)) {
          props.onEditRequest(props.block.annotationKey, event.currentTarget, event.detail)
          return
        }
        const mappingId = navigationMappingIds[0]
        if (mappingId) props.onSelect({ mappingId, origin: 'markdown' })
      }}
    >
      {props.editor ?? (props.figureGroups && props.pdfUrl ? (
        <FigureBlockPresentation
          block={props.block}
          blockIndex={props.blockIndex}
          groups={props.figureGroups}
          pdfUrl={props.pdfUrl}
          assetBaseUrl={props.assetBaseUrl}
          onRendered={props.onFigureRendered}
          readyFigureIds={props.readyFigureIds}
          mosaics={props.figureMosaics}
          onStateChange={props.onFigureStateChange}
        />
      ) : (
        <SafeMarkdown markdown={props.block.markdown} assetBaseUrl={props.assetBaseUrl} />
      ))}
    </div>
  )
})

export function FigureBlockPresentation(props: {
  block: ReaderBlock
  blockIndex: number
  groups: ReaderFigureGroup[]
  pdfUrl: string
  assetBaseUrl: string
  onRendered(): void
  readyFigureIds: ReadonlySet<string>
  mosaics: ReadonlyMap<string, FigureMosaic>
  onStateChange(id: string, state: FigureRenderState): void
}): React.JSX.Element {
  const owners = props.groups.filter(group => group.ownerBlockIndex === props.blockIndex)
  const isCaption = props.groups.some(group => props.blockIndex === group.captionBlockIndex)
  const presentation = React.useMemo(() => {
    const ready = props.groups.filter(group => group.status === 'complete' && props.readyFigureIds.has(group.id))
    return {
    // A shared paragraph may contain one caption and another figure's image.
    // Only successful crops can hide their own source assets and graphical text.
    assets: props.groups.flatMap(group => group.assetSources),
    // Panels drawn in a mosaic are hidden in every paragraph that holds them.
    hiddenAssets: [...ready.flatMap(group => group.assetSources),
      ...props.groups.flatMap(group => props.mosaics.get(group.id)?.tiles.map(tile => tile.sourceAsset) ?? [])],
    hiddenTexts: ready.flatMap(group =>
      group.supportingTextsByBlock?.[props.blockIndex] ?? group.members.filter(member => member.kind === 'supporting').map(member => member.sourceText)),
    ready: true
    }
  }, [props.groups, props.blockIndex, props.readyFigureIds, props.mosaics])
  // Same content, same object: a moved figure paragraph is not re-parsed.
  const presentationRef = React.useRef(presentation)
  if (JSON.stringify(presentationRef.current) !== JSON.stringify(presentation)) presentationRef.current = presentation
  const stablePresentation = presentationRef.current
  const source = <SafeMarkdown markdown={props.block.markdown} assetBaseUrl={props.assetBaseUrl} figurePresentation={stablePresentation} />
  return (
    <>
      {owners.filter(group => group.status === 'complete').map(group => (
        <ReaderFigureSnapshot
          key={props.pdfUrl + '|' + group.id}
          pdfUrl={props.pdfUrl}
          group={group}
          preRender
          onRendered={props.onRendered}
          onStateChange={state => props.onStateChange(group.id, state)}
        />
      ))}
      {owners.map(group => {
        const mosaic = props.mosaics.get(group.id)
        return mosaic ? <ReaderFigureMosaic key={'mosaic|' + group.id} mosaic={mosaic} assetBaseUrl={props.assetBaseUrl} /> : null
      })}
      {isCaption ? <div className="reader-figure-caption">{source}</div> : source}
    </>
  )
}
