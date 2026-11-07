import React from 'react'

/** Thin single-colour line icons for settings: 16px, 1.5px stroke, drawn in the text colour. */
function Icon(props: { children: React.ReactNode }): React.JSX.Element {
  return (
    <svg className="settings-icon" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {props.children}
    </svg>
  )
}

export const ConnectionIcon = (): React.JSX.Element => <Icon><path d="M6.5 9.5 9.5 6.5" /><path d="M7.2 4.3 8.4 3.1a2.6 2.6 0 0 1 3.7 3.7l-1.2 1.2" /><path d="M8.8 11.7 7.6 12.9a2.6 2.6 0 0 1-3.7-3.7l1.2-1.2" /></Icon>
export const KeyIcon = (): React.JSX.Element => <Icon><circle cx="5.5" cy="10.5" r="2.75" /><path d="M7.5 8.5 13 3" /><path d="M11 5l1.5 1.5" /></Icon>
export const ModelIcon = (): React.JSX.Element => <Icon><path d="M3 4.5h10M3 8h10M3 11.5h10" /><circle cx="6" cy="4.5" r="1.25" fill="var(--settings-icon-fill, var(--sheet))" /><circle cx="10.5" cy="8" r="1.25" fill="var(--settings-icon-fill, var(--sheet))" /><circle cx="7.5" cy="11.5" r="1.25" fill="var(--settings-icon-fill, var(--sheet))" /></Icon>
export const StorageIcon = (): React.JSX.Element => <Icon><path d="M2.5 5a1.5 1.5 0 0 1 1.5-1.5h2.4l1.4 1.5H12a1.5 1.5 0 0 1 1.5 1.5v5A1.5 1.5 0 0 1 12 12.5H4A1.5 1.5 0 0 1 2.5 11Z" /></Icon>
export const AppearanceIcon = (): React.JSX.Element => <Icon><circle cx="8" cy="8" r="5.25" /><path d="M8 2.75v10.5" /><path d="M8 5.5 10.5 3.8M8 8.5l4.6-3M8 11.5l4.9-3.3" /></Icon>
export const CloseIcon = (): React.JSX.Element => <Icon><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></Icon>
export const OpenFolderIcon = (): React.JSX.Element => <Icon><path d="M2.5 11V5a1.5 1.5 0 0 1 1.5-1.5h2.4l1.4 1.5H11a1.5 1.5 0 0 1 1.5 1.5v.7" /><path d="M2.5 11l1.6-3.6a1 1 0 0 1 .9-.6h8.1a.6.6 0 0 1 .6.8l-1.3 3.4a1.5 1.5 0 0 1-1.4 1H4a1.5 1.5 0 0 1-1.5-1Z" /></Icon>
export const DeleteIcon = (): React.JSX.Element => <Icon><path d="M3 4.5h10" /><path d="M6.5 4.5V3h3v1.5" /><path d="M4.5 4.5l.6 8.1a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8.1" /></Icon>
