import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertReleaseAssetNames } from './release-policy.mjs'

const desktopDirectory = dirname(dirname(fileURLToPath(import.meta.url)))
const packageJson = JSON.parse(await readFile(join(desktopDirectory, 'package.json'), 'utf8'))

try {
  const assetNames = JSON.parse(process.env.COPILOTIX_RELEASE_ASSET_NAMES_JSON ?? 'null')
  const productName = packageJson.build?.productName ?? 'Copilotix'
  const releaseName = `${productName}-${packageJson.version}-win-x64`
  assertReleaseAssetNames(assetNames, releaseName)
  process.stdout.write(`Verified all release assets for ${releaseName}.\n`)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
