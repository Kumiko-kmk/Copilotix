import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertReleaseTagMatchesVersion } from './release-policy.mjs'
import { LITE_IDENTITY } from '../src/app/contract/appIdentity.mjs'

const desktopDirectory = dirname(dirname(fileURLToPath(import.meta.url)))
const packageJson = JSON.parse(await readFile(join(desktopDirectory, 'package.json'), 'utf8'))

try {
  const lite = process.env.GITHUB_REF_NAME?.startsWith('desktop-lite-v')
  const tag = assertReleaseTagMatchesVersion(process.env.GITHUB_REF_NAME, lite ? LITE_IDENTITY.version : packageJson.version, lite ? 'lite' : 'full')
  process.stdout.write(`Release tag matches desktop package version: ${tag}\n`)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
