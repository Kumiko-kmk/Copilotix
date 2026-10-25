/** Prevent UI writes and overlapping maintenance while the library is being copied. */
export class LibraryAccessGate {
  private active = 0
  private exclusive = false
  private restartPending = false

  get busy(): boolean { return this.exclusive }
  get restarting(): boolean { return this.restartPending }
  requireRestart(): void { this.restartPending = true }

  async run<T>(channel: string, operation: () => T | Promise<T>): Promise<T> {
    if (channel.startsWith('window:')) return operation()
    if (this.exclusive || this.restartPending) throw new Error('文档库正在维护，请稍候。')
    if (channel === 'library:manage') {
      if (this.active) throw new Error('仍有文档操作尚未结束，请稍后再试。')
      this.exclusive = true
      try { return await operation() } finally { this.exclusive = false }
    }
    this.active++
    try { return await operation() } finally { this.active-- }
  }
}
