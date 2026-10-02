import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyWindowsAuthenticodeSignature } from './package-directory.mjs'

/** Runs during final NSIS compilation, after builder signs the intermediate uninstaller. */
export async function verifyUninstallerSignature(configPath, executablePath, verifySignature = verifyWindowsAuthenticodeSignature) {
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  if (typeof config.signerSubject !== 'string' || !config.signerSubject.trim() || typeof config.resultPath !== 'string') {
    throw new Error('Invalid uninstaller signature gate configuration')
  }
  const signerSubject = await verifySignature(executablePath)
  if (signerSubject !== config.signerSubject) throw new Error('Embedded uninstaller signer does not match the runtime signer')
  await writeFile(config.resultPath, JSON.stringify({ signerSubject }), 'utf8')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error('Uninstaller signature gate requires configuration and executable paths')
    await verifyUninstallerSignature(process.argv[2], process.argv[3])
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
