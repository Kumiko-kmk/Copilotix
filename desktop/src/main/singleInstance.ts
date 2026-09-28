interface InstanceApplication {
  requestSingleInstanceLock(): boolean
  on(event: 'second-instance', listener: () => void): unknown
  quit(): void
}
interface InstanceWindow {
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
}

export function acquirePrimaryInstance(app: InstanceApplication, getWindow: () => InstanceWindow | null): boolean {
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return false
  }
  app.on('second-instance', () => {
    const window = getWindow()
    if (!window) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  })
  return true
}
