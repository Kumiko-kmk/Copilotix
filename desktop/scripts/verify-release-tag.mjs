import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertReleaseTagMatchesVersion } from './release-policy.mjs'

const desktopDirectory = dirname(dirname(fileURLToPath(import.meta.url)))
const packageJson = JSON.parse(await readFile(join(desktopDirectory, 'package.json'), 'utf8'))

try {
  const tag = assertReleaseTagMatchesVersion(process.env.GITHUB_REF_NAME, packageJson.version)
  process.stdout.write(`Release tag matches desktop package version: ${tag}\n`)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
