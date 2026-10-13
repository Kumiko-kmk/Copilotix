import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'

type Packet = { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } }
/** Newline framed RPC. Never log packets: they can contain account data or paper text. */
export class CodexConnection extends EventEmitter {
  private nextId = 0
  private buffer = ''
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  private closed = false
  readonly child: ChildProcessWithoutNullStreams

  constructor(executable: string, args: string[], cwd: string) {
    super()
    this.child = spawn(executable, args, { cwd, windowsHide: true, shell: false, stdio: 'pipe' })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => this.receive(chunk))
    this.child.stdin.on('error', () => this.close(new Error('Codex 输入管道已关闭')))
    this.child.stderr.on('data', () => { /* Drain stderr without persisting private configuration. */ })
    this.child.on('error', () => this.close(new Error('无法启动 Codex，请检查可执行文件路径')))
    this.child.on('exit', () => this.close(new Error('Codex 进程已退出，请重试')))
  }

  request<T = unknown>(method: string, params: unknown, timeout = 15_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Codex 连接已关闭'))
    const id = ++this.nextId
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} 超时`)) }, timeout)
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer })
      this.write({ id, method, params })
    })
  }

  notify(method: string): void { this.write({ method }) }
  private write(packet: unknown): void {
    if (!this.closed) this.child.stdin.write(`${JSON.stringify(packet)}\n`, error => { if (error) this.close(new Error('Codex 通信中断')) })
  }
  private receive(chunk: string): void {
    this.buffer += chunk
    if (Buffer.byteLength(this.buffer) > 24 * 1024 * 1024) { this.close(new Error('Codex 消息超过大小限制')); return }
    let newline: number
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      if (this.closed) return
      const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1)
      if (!line.trim()) continue
      let packet: Packet
      try { packet = JSON.parse(line) as Packet } catch { this.close(new Error('Codex 返回无效协议消息')); return }
      if (!packet || typeof packet !== 'object' || Array.isArray(packet)) { this.close(new Error('Codex 返回无效协议消息')); return }
      if (packet.method && packet.id !== undefined) {
        // This integration never grants tool/permission requests or handles login tokens.
        this.write({ id: packet.id, error: { code: -32601, message: 'Tools and approval requests are disabled in Copilotix' } })
        this.emit('forbidden')
      } else if (typeof packet.id === 'number') {
        const call = this.pending.get(packet.id)
        if (!call) continue
        this.pending.delete(packet.id); clearTimeout(call.timer)
        if (packet.error) call.reject(new Error('Codex 请求失败，请检查登录、模型权限或版本兼容性'))
        else call.resolve(packet.result)
      } else if (packet.method) this.emit('notification', packet.method, packet.params ?? {})
    }
  }
  close(error = new Error('Codex 连接已关闭')): void {
    if (this.closed) return
    this.closed = true
    for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(error) }
    this.pending.clear()
    this.child.kill()
    this.emit('closed', error)
  }
}
