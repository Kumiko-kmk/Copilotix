import { access, readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const desktopDirectory = resolve(scriptDirectory, '..')
const utilityEntry = './out/utility/index.js'
const MAX_CAPTURED_OUTPUT = 16 * 1024

/**
 * Keep this check independent from process execution so the failure contract
 * can be tested without starting Electron.  The utility entry intentionally
 * throws this one error when loaded without Electron's parent port.
 */
export function isExpectedUtilityBundleFailure(result) {
  if (!result || result.exitCode === 0 || result.signal) return false
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  if (!output.includes('Core utility parent port is unavailable')) return false
  return !/(?:ReferenceError|TypeError|SyntaxError|RangeError|DOMException|document(?:\.createElement| is not defined)|MODULE_NOT_FOUND|Cannot find module)/iu.test(output)
}

/** Utility output must not contain a browser-only DOM implementation. */
export function findForbiddenUtilityRuntime(source) {
  const forbidden = [
    /\bdocument\s*\.\s*createElement\b/iu,
    /\bdocument\s+is\s+not\s+defined\b/iu,
    /\b(?:window|navigator)\s*\.\s*[A-Za-z_$]/u
  ]
  return forbidden.find((pattern) => pattern.test(source))?.source ?? null
}

function capture(stream) {
  let value = ''
  stream?.setEncoding('utf8')
  stream?.on('data', (chunk) => {
    if (value.length >= MAX_CAPTURED_OUTPUT) return
    value += String(chunk).slice(0, MAX_CAPTURED_OUTPUT - value.length)
  })
  return () => value
}

function runChild(executable, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, {
      cwd: desktopDirectory,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    const stdout = capture(child.stdout)
    const stderr = capture(child.stderr)
    let settled = false
    child.once('error', (error) => {
      if (settled) return
      settled = true
      rejectPromise(error)
    })
    child.once('close', (exitCode, signal) => {
      if (settled) return
      settled = true
      resolvePromise({ exitCode, signal, stdout: stdout(), stderr: stderr() })
    })
  })
}

async function executableForHost() {
  if (process.platform !== 'win32') return process.execPath
  const electronExecutable = join(desktopDirectory, 'node_modules', 'electron', 'dist', 'electron.exe')
  await access(electronExecutable)
  return electronExecutable
}

async function main() {
  const bundlePath = join(desktopDirectory, 'out', 'utility', 'index.js')
  await access(bundlePath)
  const bundleSource = await readFile(bundlePath, 'utf8')
  if (findForbiddenUtilityRuntime(bundleSource)) throw new Error('browser utility runtime detected')
  const executable = await executableForHost()
  const result = await runChild(executable, ['-e', `require('${utilityEntry}')`])
  if (!isExpectedUtilityBundleFailure(result)) throw new Error('unexpected utility bundle load result')
  process.stdout.write('Utility bundle smoke passed\n')
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    await main()
  } catch {
    // Never expose a local path, URL, token, or child-process stack in build logs.
    process.stderr.write('Utility bundle smoke failed\n')
    process.exitCode = 1
  }
}
