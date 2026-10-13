import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexConnection } from '../src/runtime/codexConnection'

const factory = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: factory.spawn }))
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })
function fixture() {
  const packets: Array<Record<string, unknown>> = []
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
    stdin: new Writable({ write(chunk, _encoding, done) { packets.push(JSON.parse(String(chunk))); done() } })
  })
  factory.spawn.mockReturnValue(child)
  const connection = new CodexConnection('C:/Codex/codex.exe', ['app-server'], 'C:/work')
  return { connection, child, packets }
}
describe('Codex stdio transport', () => {
  it('frames split UTF-8 messages and correlates out-of-order responses', async () => {
    const f = fixture(), events = vi.fn()
    f.connection.on('notification', events)
    const one = f.connection.request('one', {}), two = f.connection.request('two', {})
    const bytes = Buffer.from('{"method":"delta","params":{"text":"中文"}}\n{"id":2,"result":"second"}\n{"id":1,"result":"first"}\n')
    f.child.stdout.write(bytes.subarray(0, 38)); f.child.stdout.write(bytes.subarray(38))
    await expect(one).resolves.toBe('first'); await expect(two).resolves.toBe('second')
    expect(events).toHaveBeenCalledWith('delta', { text: '中文' })
    expect(factory.spawn).toHaveBeenCalledWith('C:/Codex/codex.exe', ['app-server'], expect.objectContaining({ shell: false, windowsHide: true }))
    f.connection.close()
  })
  it('rejects approval requests and never executes tools', () => {
    const f = fixture(), forbidden = vi.fn()
    f.connection.on('forbidden', forbidden)
    f.child.stdout.write('{"id":"approval","method":"item/commandExecution/requestApproval","params":{}}\n')
    expect(forbidden).toHaveBeenCalledOnce()
    expect(f.packets[0]).toMatchObject({ id: 'approval', error: { code: -32601 } })
    f.connection.close()
  })
  it('settles all pending calls on malformed output or process exit', async () => {
    const f = fixture(), pending = f.connection.request('one', {})
    const rejected = expect(pending).rejects.toThrow('无效协议')
    f.child.stdout.write('not-json\n'); await rejected
    expect(f.child.kill).toHaveBeenCalledOnce()
    await expect(f.connection.request('two', {})).rejects.toThrow('关闭')
  })
  it('bounds initialization time and ignores late replies', async () => {
    vi.useFakeTimers()
    const f = fixture(), pending = f.connection.request('initialize', {}, 10)
    const rejected = expect(pending).rejects.toThrow('超时')
    await vi.advanceTimersByTimeAsync(11); await rejected
    f.child.stdout.write('{"id":1,"result":{}}\n')
    f.connection.close()
  })
})
