import { FuseV1Options, FuseVersion, flipFuses, getCurrentFuseWire } from '@electron/fuses'

// @electron/fuses exposes these wire bytes through getCurrentFuseWire but does
// not export the enum from its public entry point.
const ElectronFuseState = Object.freeze({ DISABLE: 0x30, ENABLE: 0x31 })

export const desktopFuseOptions = Object.freeze({
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true
})

export const desktopFuseConfig = Object.freeze({
  version: FuseVersion.V1,
  strictlyRequireAllFuses: false,
  ...desktopFuseOptions
})

export async function applyDesktopFuses(electronExecutable) {
  if (typeof electronExecutable !== 'string' || !electronExecutable) {
    throw new TypeError('Electron executable path is required')
  }
  await flipFuses(electronExecutable, desktopFuseConfig)
  const actual = await getCurrentFuseWire(electronExecutable)
  assertDesktopFuses(actual)
  return actual
}

/** Read-back verification uses the byte states exposed by @electron/fuses. */
export function assertDesktopFuses(actual) {
  if (!actual || actual.version !== FuseVersion.V1) {
    throw new Error(`Unexpected Electron fuse wire version: ${String(actual?.version)}`)
  }
  for (const [option, expected] of Object.entries(desktopFuseOptions)) {
    const expectedState = expected ? ElectronFuseState.ENABLE : ElectronFuseState.DISABLE
    const actualState = actual[option]
    if (actualState !== expectedState) {
      throw new Error(`Electron fuse ${option} read-back mismatch: expected ${String(expectedState)}, received ${String(actualState)}`)
    }
  }
  return true
}

if (process.argv[1] && new URL(import.meta.url).pathname === new URL(`file://${process.argv[1].replaceAll('\\', '/')}`).pathname) {
  await applyDesktopFuses(process.argv[2])
}
