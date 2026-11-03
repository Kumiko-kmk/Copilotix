import React from 'react'
import { Button, Modal } from 'antd'
import type { SettingsNavigationGuard } from '@features/settings/renderer'

/** The current view; leaving settings with unsaved changes asks to save, discard or stay. */
export function useGuardedViews<View extends { name: string }>(initial: View) {
  const [view, setView] = React.useState<View>(initial)
  const viewRef = React.useRef(view)
  viewRef.current = view
  const settingsGuard = React.useRef<SettingsNavigationGuard | null>(null)
  const [guardBusy, setGuardBusy] = React.useState(false)
  const [pendingView, setPendingView] = React.useState<View | null>(null)
  const [leaving, setLeaving] = React.useState(false)
  const leavingRef = React.useRef(false)
  const onNavigationGuardChange = React.useCallback((guard: SettingsNavigationGuard | null) => {
    settingsGuard.current = guard
    setGuardBusy(Boolean(guard?.busy))
  }, [])
  const requestViewChange = React.useCallback((next: View) => {
    if (leavingRef.current) return
    if (viewRef.current.name === 'settings' && next.name !== 'settings' && (settingsGuard.current?.dirty || settingsGuard.current?.busy)) {
      setPendingView(next)
    } else setView(next)
  }, [])
  const saveAndLeave = async (): Promise<void> => {
    const guard = settingsGuard.current
    if (!pendingView || !guard || guard.busy || leavingRef.current) return
    const destination = pendingView
    leavingRef.current = true
    setLeaving(true)
    try {
      if (await guard.save()) setView(destination)
    } finally {
      setPendingView(null)
      leavingRef.current = false
      setLeaving(false)
    }
  }
  const discardAndLeave = (): void => {
    if (!pendingView || guardBusy || leavingRef.current) return
    settingsGuard.current?.discard()
    setView(pendingView)
    setPendingView(null)
  }
  const guardDialog = (
    <Modal title="有未保存的设置" open={pendingView !== null} closable={!leaving} maskClosable={!leaving}
      onCancel={() => { if (!leaving) setPendingView(null) }}
      footer={[
        <Button key="stay" disabled={leaving} onClick={() => setPendingView(null)}>继续编辑</Button>,
        <Button key="discard" disabled={leaving || guardBusy} onClick={discardAndLeave}>放弃并离开</Button>,
        <Button key="save" type="primary" loading={leaving} disabled={guardBusy} onClick={() => void saveAndLeave()}>保存并离开</Button>
      ]}>
      <p>离开前保存修改，或放弃本次未保存的更改。</p>
    </Modal>
  )
  return { view, requestViewChange, onNavigationGuardChange, guardDialog }
}
