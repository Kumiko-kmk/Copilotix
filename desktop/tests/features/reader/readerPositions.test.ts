import { expect, it } from 'vitest'
import { freshReaderPositions, sessionReaderPositions } from '@features/reader/renderer/readerPositions'

it('gives a paper the same positions for the whole session, and other papers their own', () => {
  const first = sessionReaderPositions('paper-a')
  first.scroll.original = 2400
  first.pdf = { zoom: 1.5, anchor: null }
  expect(sessionReaderPositions('paper-b').scroll.original).toBe(0)
  expect(sessionReaderPositions('paper-a')).toBe(first)
})

it('drops the least recently read paper first once the session limit is reached', () => {
  const kept = sessionReaderPositions('kept')
  kept.scroll.translated = 10
  const dropped = sessionReaderPositions('dropped')
  dropped.scroll.translated = 20
  sessionReaderPositions('kept')
  for (let index = 0; index < 127; index += 1) sessionReaderPositions(`other-${index}`)
  expect(sessionReaderPositions('kept').scroll.translated).toBe(10)
  expect(sessionReaderPositions('dropped').scroll.translated).toBe(0)
})

it('starts at the top when a caller does not resume', () => {
  expect(freshReaderPositions()).toEqual({ scroll: { original: 0, translated: 0 }, pdf: null })
})
