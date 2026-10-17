import React from 'react'
import type { FigureMosaic } from '../readerFigureMosaic'
import { resolveAsset } from './SafeMarkdown'

/**
 * The parsed panel images of one figure at their PDF positions (readerFigureMosaic.ts). Panels
 * count as figure sources, so a missing one never fails the whole Markdown render.
 */
export default function ReaderFigureMosaic(props: { mosaic: FigureMosaic; assetBaseUrl: string }): React.JSX.Element {
  const { mosaic } = props
  return (
    <div
      className="reader-figure-mosaic"
      data-reader-annotation-ignore="true"
      style={{ aspectRatio: String(mosaic.aspect), width: `${Math.round(Math.min(100, mosaic.pageShare * 135))}%` }}
    >
      {mosaic.tiles.map(tile => (
        <img
          key={tile.sourceAsset}
          src={resolveAsset(tile.src, props.assetBaseUrl)}
          alt=""
          loading="eager"
          decoding="async"
          data-reader-figure-source="true"
          style={{ left: `${tile.left * 100}%`, top: `${tile.top * 100}%`, width: `${tile.width * 100}%`, height: `${tile.height * 100}%` }}
        />
      ))}
    </div>
  )
}
