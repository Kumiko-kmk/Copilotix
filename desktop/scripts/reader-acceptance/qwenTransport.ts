import { spawn } from 'node:child_process'

/** Windows system TLS transport; credentials enter curl only through its private stdin. */
export function systemQwenFetch() {
  return async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (String(url) !== 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions') throw new Error('Unexpected translation endpoint')
    const quote = (value: string) => '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, '') + '"'
    const headers = new Headers(init?.headers)
    const configuration = [`url = ${quote(String(url))}`, 'request = "POST"',
      `header = ${quote('Authorization: ' + headers.get('authorization'))}`, 'header = "Content-Type: application/json"',
      `data-binary = ${quote(String(init?.body ?? ''))}`].join('\n')
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn('curl.exe', ['--config', '-', '--silent', '--max-time', '80', '--write-out', '\n%{http_code}'],
          { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], signal: init?.signal ?? undefined })
        let output = ''
        child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
        child.once('error', () => reject(new TypeError('System HTTP transport failed')))
        child.once('close', code => code === 0 ? resolve(output) : reject(new TypeError(`System HTTP transport exit ${code}`)))
        child.stdin.on('error', () => {})
        child.stdin.end(configuration)
      })
      const split = output.lastIndexOf('\n')
      return new Response(output.slice(0, split), { status: Number(output.slice(split + 1)), headers: { 'Content-Type': 'application/json' } })
  }
}
