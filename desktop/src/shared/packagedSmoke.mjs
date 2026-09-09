export const PACKAGED_SMOKE_ARG = '--copilotix-packaged-smoke'
export const PACKAGED_SMOKE_MARKER_PREFIX = 'COPILOTIX_PACKAGED_SMOKE_OK'

const SAFE_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/u

export function shouldRunPackagedSmoke(args, isPackaged) {
  return isPackaged === true && Array.isArray(args) && args.includes(PACKAGED_SMOKE_ARG)
}

export function formatPackagedSmokeMarker({ appVersion, electronVersion }) {
  assertSafeVersion(appVersion, 'app version')
  assertSafeVersion(electronVersion, 'Electron version')
  return `${PACKAGED_SMOKE_MARKER_PREFIX} app=${appVersion} electron=${electronVersion}\n`
}

export function validatePackagedSmokeOutput({ stdout, stderr }, expectedVersions) {
  if (typeof stdout !== 'string' || typeof stderr !== 'string') return false
  let expectedMarker
  try {
    expectedMarker = formatPackagedSmokeMarker(expectedVersions)
  } catch {
    return false
  }
  const normalizedStdout = stdout.replace(/\r\n/gu, '\n')
  return stderr.length === 0 && (normalizedStdout === expectedMarker || normalizedStdout === `\n${expectedMarker}`)
}

function assertSafeVersion(value, label) {
  if (typeof value !== 'string' || !SAFE_VERSION_PATTERN.test(value)) {
    throw new TypeError(`Invalid ${label}`)
  }
}
