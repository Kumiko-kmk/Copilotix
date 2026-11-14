import React from 'react'
import { ConfigProvider, Modal } from 'antd'
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
      transitionName=""
      maskTransitionName=""
      destroyOnHidden
      width="clamp(min(880px, calc(100vw - 48px)), calc(100vw - 280px), 1000px)"
      rootClassName="settings-dialog"
      aria-label="設定"
    >
      {/* Two-character labels such as 測試 stay as written instead of being spread apart. */}
      <ConfigProvider button={{ autoInsertSpace: false }}>
        <SettingsPage {...page} onExit={onClose} />
      </ConfigProvider>
    </Modal>
  )
}
