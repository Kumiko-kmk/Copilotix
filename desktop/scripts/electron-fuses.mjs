import { FuseV1Options, FuseVersion, flipFuses } from '@electron/fuses'

export const desktopFuseOptions = Object.freeze({
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true
})

export async function applyDesktopFuses(electronExecutable) {
  if (typeof electronExecutable !== 'string' || !electronExecutable) {
    throw new TypeError('Electron executable path is required')
  }
  await flipFuses(electronExecutable, FuseVersion.V1, desktopFuseOptions)
}

if (process.argv[1] && new URL(import.meta.url).pathname === new URL(`file://${process.argv[1].replaceAll('\\', '/')}`).pathname) {
  await applyDesktopFuses(process.argv[2])
}
