import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertDesktopReleaseLicenseMetadata } from './release-policy.mjs'

const desktopDirectory = dirname(dirname(fileURLToPath(import.meta.url)))
const packageJson = JSON.parse(await readFile(join(desktopDirectory, 'package.json'), 'utf8'))

try {
  const license = assertDesktopReleaseLicenseMetadata(packageJson)
  process.stdout.write(`Desktop release license declaration is present: ${license}\n`)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
