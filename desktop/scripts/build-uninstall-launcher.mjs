import { execFile } from 'node:child_process'
import { readFile, stat, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const desktopDirectory = resolve(scriptDirectory, '..')
const execute = promisify(execFile)
export const INSTALLATION_GUID = '14328922-5660-531d-8d5f-b169b5a958e0'

/** Fail closed for incomplete paths or registry commands containing arguments. */
export function registeredUninstallerPath(root, command) {
  if (typeof root !== 'string' || typeof command !== 'string' || /["\r\n\0]/u.test(root)) return null
  if (!win32.isAbsolute(root) || win32.parse(root).root.toLowerCase() === root.toLowerCase()) return null
  if (win32.normalize(root).toLowerCase() !== root.toLowerCase()) return null
  for (const name of ['uninstall.exe', 'Uninstall Copilotix.exe']) {
    const target = win32.join(root, name)
    if ([`"${target}"`, `"${target}" /currentuser`].some((value) => value.toLowerCase() === command.toLowerCase())) return target
  }
  return null
}

export function nsisDefine(name, value) {
  if (typeof value !== 'string' || !value || /["\r\n$\0]/u.test(value)) throw new Error(`Unsafe NSIS define ${name}`)
  return `/D${name}=${value}`
}

/** Compile using electron-builder's pinned/verified toolset; production signs via the same packager as Setup. */
export async function buildStandaloneUninstaller({ outputPath, productionRelease = false, signerSubject = null, signFile = null, verifySignature = null, compiler = null, installGuid = INSTALLATION_GUID } = {}) {
  if (process.platform !== 'win32') throw new Error('The standalone uninstaller requires Windows')
  if (typeof outputPath !== 'string' || !win32.isAbsolute(outputPath) || win32.basename(outputPath).toLowerCase() !== 'uninstall.exe') throw new Error('An absolute uninstall.exe output path is required')
  if (productionRelease && (!signerSubject || typeof signFile !== 'function' || typeof verifySignature !== 'function')) throw new Error('Production uninstaller requires signing and trusted signature verification')
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(installGuid) || (productionRelease && installGuid !== INSTALLATION_GUID)) throw new Error('Invalid installation identity for uninstall launcher')
  const packageJson = JSON.parse(await readFile(resolve(desktopDirectory, 'package.json'), 'utf8'))
  const require = createRequire(resolve(desktopDirectory, 'package.json'))
  const builderRoot = dirname(require.resolve('app-builder-lib/package.json', { paths: [dirname(require.resolve('electron-builder/package.json'))] }))
  const tools = require(resolve(builderRoot, 'out/toolsets/windows.js'))
  const tool = compiler ?? await tools.getMakeNsisPath(packageJson.build?.toolsets?.nsis, packageJson.build?.nsis?.customNsisBinary)
  const version = /^([0-9]+\.[0-9]+\.[0-9]+)/u.exec(packageJson.version)?.[1]
  if (!version) throw new Error('Invalid launcher product version')
  await mkdir(dirname(outputPath), { recursive: true })
  await execute(tool.path, ['/V2', '/INPUTCHARSET', 'UTF8', nsisDefine('OUTPUT_PATH', outputPath), nsisDefine('ICON_PATH', resolve(desktopDirectory, 'resources/icon.ico')), nsisDefine('PRODUCT_VERSION', `${version}.0`), nsisDefine('INSTALL_GUID', installGuid), resolve(desktopDirectory, 'resources/uninstall-launcher.nsi')], { env: { ...process.env, ...tool.env }, windowsHide: true, maxBuffer: 1024 * 1024 })
  if (productionRelease) {
    await signFile(outputPath)
    if (await verifySignature(outputPath) !== signerSubject) throw new Error('Standalone uninstaller signer does not match the runtime signer')
  }
  const info = await stat(outputPath)
  if (!info.isFile() || info.size === 0 || info.size > 1024 * 1024) throw new Error('Invalid or unexpectedly large uninstall launcher')
  return Object.freeze({ path: outputPath, sizeBytes: info.size, signerSubject: productionRelease ? signerSubject : null })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildStandaloneUninstaller({ outputPath: process.argv[2] }).then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
