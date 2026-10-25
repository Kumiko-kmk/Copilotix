import React from 'react'
import SafeMarkdown from '../components/SafeMarkdown'
import { prepareReaderMarkdown } from '@platform/markdown/core/standardMarkdown'
import { remarkArchiveVariables } from './archiveVariables'

const plugins = [remarkArchiveVariables]

/** Display-only preparation: never change the saved brief or source document. */
export default function ArchiveText({ text }: { text: string }): React.JSX.Element {
  const markdown = React.useMemo(() => prepareReaderMarkdown(text), [text])
  return <span className="paper-archive-text"><SafeMarkdown markdown={markdown} inline remarkPlugins={plugins} /></span>
}
