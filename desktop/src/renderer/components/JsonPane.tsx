import React from 'react'

export default React.memo(function JsonPane(props: {
  json: string
  query: string
  active: boolean
}): React.JSX.Element {
  const deferredQuery = React.useDeferredValue(props.query.trim())
  const content = React.useMemo(
    () => deferredQuery ? jsonSearchExcerpt(props.json, deferredQuery) : props.json,
    [deferredQuery, props.json]
  )

  return (
    <textarea
      className="json-view"
      aria-label="JSON 内容"
      aria-hidden={!props.active}
      readOnly
      spellCheck={false}
      wrap="off"
      value={content}
    />
  )
})

export function jsonSearchExcerpt(json: string, query: string): string {
  const expression = new RegExp(escapeRegExp(query), 'i')
  const match = expression.exec(json)
  if (!match || match.index === undefined) return json
  const start = Math.max(0, match.index - 500)
  const end = Math.min(json.length, match.index + match[0].length + 1_500)
  return (start > 0 ? '…\n' : '') + json.slice(start, end) + (end < json.length ? '\n…' : '')
}

function escapeRegExp(value: string): string {
  return value.replace(/[$.*+?^{}()|[\]\\]/g, '\\$&')
}
