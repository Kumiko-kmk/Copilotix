import { assertReleaseSigningConfiguration } from './release-policy.mjs'

try {
  assertReleaseSigningConfiguration(process.env)
  process.stdout.write('Production release signing certificate is configured.\n')
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
