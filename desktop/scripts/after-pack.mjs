import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyDesktopFuses } from './electron-fuses.mjs'

const scriptDirectory = resolve(fileURLToPath(new URL('.', import.meta.url)))
const desktopDirectory = resolve(scriptDirectory, '..')
const packageJson = JSON.parse(await readFile(join(desktopDirectory, 'package.json'), 'utf8'))

/** Flip and read back fuses while the packaged Windows executable is unsigned. */
export async function applyReleaseFusesAfterPack(context, applyFuses = applyDesktopFuses) {
  if (context?.electronPlatformName !== 'win32') {
    throw new Error(`Windows afterPack hook received unexpected platform: ${String(context?.electronPlatformName)}`)
  }
  if (typeof context.appOutDir !== 'string' || !context.appOutDir) {
    throw new TypeError('electron-builder afterPack context is missing appOutDir')
  }
  const executableName = packageJson.build?.executableName ?? packageJson.build?.productName ?? 'Copilotix'
  const executablePath = join(context.appOutDir, `${executableName}.exe`)
  await applyFuses(executablePath)
  return executablePath
}

export default applyReleaseFusesAfterPack
