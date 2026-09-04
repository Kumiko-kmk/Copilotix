export const PACKAGED_SMOKE_ARG: '--mineru-packaged-smoke'
export const PACKAGED_SMOKE_MARKER_PREFIX: 'MINERU_PACKAGED_SMOKE_OK'

export interface PackagedSmokeVersions {
  appVersion: string
  electronVersion: string
}

export function shouldRunPackagedSmoke(args: readonly string[], isPackaged: boolean): boolean
export function formatPackagedSmokeMarker(versions: PackagedSmokeVersions): string
export function validatePackagedSmokeOutput(
  output: { stdout: string; stderr: string },
  expectedVersions: PackagedSmokeVersions
): boolean
