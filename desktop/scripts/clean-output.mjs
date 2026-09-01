import { rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertSafeBuildOutputPath } from './release-policy.mjs'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const desktopDirectory = resolve(scriptDirectory, '..')
const outputDirectory = join(desktopDirectory, 'out')

assertSafeBuildOutputPath(desktopDirectory, outputDirectory)
await rm(outputDirectory, { recursive: true, force: true })
process.stdout.write(`Cleaned build output: ${outputDirectory}\n`)
