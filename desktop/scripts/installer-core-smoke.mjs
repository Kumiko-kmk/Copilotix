import { spawnSync } from 'node:child_process'
import { PACKAGED_SMOKE_ARG, validatePackagedSmokeOutput } from '../src/shared/packagedSmoke.mjs'

const [executable, appVersion, electronVersion] = process.argv.slice(2)
const result = spawnSync(executable, [PACKAGED_SMOKE_ARG], {
  encoding: 'utf8', windowsHide: true, timeout: 30_000
})
if (result.error) throw result.error
if (result.status !== 0 || !validatePackagedSmokeOutput(result, { appVersion, electronVersion })) {
  throw new Error(`Installed application smoke failed (exit ${result.status}): ${result.stdout} ${result.stderr}`)
}
