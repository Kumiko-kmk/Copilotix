import React from 'react'
import type { DocumentSummary } from '../contract/documentSchemas'
import CopilotixWordmark from './home/CopilotixWordmark'
import { HomeBackdrop } from './home/HomeScene'
import { HomeGreeting } from './home/HomeWidgets'
import NewParsePage from './NewParsePage'

/** The full edition's home: the import page inside the cipher field, wordmark and greeting. */
export default function DecoratedHomePage(props: Omit<React.ComponentProps<typeof NewParsePage>, 'decoration'> & { documents: readonly DocumentSummary[] }): React.JSX.Element {
  const { documents, ...page } = props
  return <NewParsePage {...page} decoration={{ backdrop: <HomeBackdrop documents={documents} />, wordmark: <CopilotixWordmark />, greeting: <HomeGreeting /> }} />
}
