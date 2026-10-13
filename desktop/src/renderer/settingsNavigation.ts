export interface SettingsNavigationGuard {
  dirty: boolean
  busy: boolean
  save(): Promise<boolean>
  discard(): void
}
