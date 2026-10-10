import { readdir, utimes } from 'node:fs/promises'
import { join } from 'node:path'

/** Distribution files describe this build, rather than the 1980 dates in reproducible dependencies. */
export async function stampRuntimeFileTimes(directory, buildTime = new Date()) {
  if (!(buildTime instanceof Date) || !Number.isFinite(buildTime.getTime())) throw new TypeError('Invalid runtime build time')
  let count = 0
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = join(current, entry.name)
      if (entry.isDirectory()) await visit(target)
      else if (entry.isFile()) { await utimes(target, buildTime, buildTime); count++ }
      else throw new Error(`Unexpected runtime entry: ${target}`)
    }
  }
  await visit(directory)
  return count
}
