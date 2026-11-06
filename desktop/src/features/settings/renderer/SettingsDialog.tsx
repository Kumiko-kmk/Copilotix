import React from 'react'
import { Modal } from 'antd'
import SettingsPage from './SettingsPage'

type SettingsPageProps = React.ComponentProps<typeof SettingsPage>

/**
 * Settings in a window over the app rather than in place of it. Closing (the button, Esc or a click
 * outside) goes through onClose, so the caller's unsaved-changes check still applies.
 */
export default function SettingsDialog(props: Omit<SettingsPageProps, 'onExit'> & { open: boolean; onClose(): void }): React.JSX.Element {
  const { open, onClose, ...page } = props
  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      closable={false}
      centered
      destroyOnHidden
      width="clamp(min(880px, calc(100vw - 48px)), calc(100vw - 280px), 1000px)"
      rootClassName="settings-dialog"
      aria-label="设置"
    >
      <SettingsPage {...page} onExit={onClose} />
    </Modal>
  )
}
