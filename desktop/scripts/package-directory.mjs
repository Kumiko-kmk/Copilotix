import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import archiver from 'archiver'
import extract from 'extract-zip'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const desktopDirectory = resolve(scriptDirectory, '..')
const repositoryRoot = resolve(desktopDirectory, '..')
const releaseRoot = join(repositoryRoot, 'release')
const stagingDirectory = join(releaseRoot, '.staging')
const packageJson = JSON.parse(await readFile(join(desktopDirectory, 'package.json'), 'utf8'))
const require = createRequire(import.meta.url)
const productName = packageJson.build?.productName ?? 'MinerU'
const releaseName = `${productName}-${packageJson.version}-win-x64`
const runtimeDirectory = join(releaseRoot, releaseName)
const zipPath = join(releaseRoot, `${releaseName}.zip`)
const executableName = `${packageJson.build?.executableName ?? productName}.exe`

assertExactReleaseRoot()
await rm(releaseRoot, { recursive: true, force: true })
await mkdir(stagingDirectory, { recursive: true })
await runElectronBuilder()

const unpackedDirectory = join(stagingDirectory, 'win-unpacked')
await requireFile(join(unpackedDirectory, executableName))
await requireFile(join(unpackedDirectory, 'resources', 'app.asar'))
await rename(unpackedDirectory, runtimeDirectory)
await rm(stagingDirectory, { recursive: true, force: true })

await createReleaseZip(runtimeDirectory, zipPath, releaseName)
await verifyReleaseZip(zipPath, releaseName, executableName)

const executableHash = await sha256(join(runtimeDirectory, executableName))
const zipHash = await sha256(zipPath)
const createdAt = new Date().toISOString()
const manifest = {
  schemaVersion: 1,
  productName,
  version: packageJson.version,
  platform: 'win32',
  architecture: 'x64',
  createdAt,
  runtime: {
    directory: releaseName,
    entryPoint: `${releaseName}/${executableName}`,
    sha256: executableHash
  },
  transport: {
    file: `${releaseName}.zip`,
    sha256: zipHash
  }
}
await writeFile(join(releaseRoot, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
await writeFile(
  join(releaseRoot, 'SHA256SUMS.txt'),
  `${zipHash} *${releaseName}.zip\n${executableHash} *${releaseName}/${executableName}\n`,
  'utf8'
)

process.stdout.write(`Release directory: ${runtimeDirectory}\n`)
process.stdout.write(`Release archive:   ${zipPath}\n`)
process.stdout.write(`ZIP SHA-256:       ${zipHash}\n`)

function assertExactReleaseRoot() {
  const expected = resolve(repositoryRoot, 'release')
  if (resolve(releaseRoot) !== expected || dirname(expected) !== repositoryRoot) {
    throw new Error(`Refusing to reset unexpected release path: ${releaseRoot}`)
  }
}

function assertWithinReleaseRoot(target) {
  const pathFromRoot = relative(releaseRoot, target)
  if (!pathFromRoot || pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) {
    throw new Error(`Path must be a child of the release root: ${target}`)
  }
}

async function runElectronBuilder() {
  const electronBuilderCli = require.resolve('electron-builder/out/cli/cli.js')
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [electronBuilderCli, '--win', 'dir', '--x64'], {
      cwd: desktopDirectory,
      stdio: 'inherit',
      windowsHide: true
    })
    child.once('error', rejectPromise)
    child.once('exit', (code) => {
      if (code === 0) resolvePromise()
      else rejectPromise(new Error(`electron-builder exited with code ${String(code)}`))
    })
  })
}

async function createReleaseZip(sourceDirectory, destination, rootName) {
  assertWithinReleaseRoot(sourceDirectory)
  assertWithinReleaseRoot(destination)
  await new Promise((resolvePromise, rejectPromise) => {
    const output = createWriteStream(destination)
    const archive = archiver('zip', { zlib: { level: 9 } })
    output.once('close', resolvePromise)
    output.once('error', rejectPromise)
    archive.once('error', rejectPromise)
    archive.pipe(output)
    archive.directory(sourceDirectory, rootName)
    void archive.finalize()
  })
}

async function verifyReleaseZip(archivePath, rootName, mainExecutable) {
  const verificationDirectory = join(releaseRoot, '.verify')
  assertWithinReleaseRoot(verificationDirectory)
  try {
    await rm(verificationDirectory, { recursive: true, force: true })
    await mkdir(verificationDirectory, { recursive: true })
    await extract(archivePath, { dir: verificationDirectory })
    await requireFile(join(verificationDirectory, rootName, mainExecutable))
    await requireFile(join(verificationDirectory, rootName, 'resources', 'app.asar'))
  } finally {
    await rm(verificationDirectory, { recursive: true, force: true })
  }
}

async function requireFile(path) {
  const details = await stat(path)
  if (!details.isFile() || details.size === 0) throw new Error(`Required release file is missing or empty: ${path}`)
}

async function sha256(path) {
  const hash = createHash('sha256')
  await new Promise((resolvePromise, rejectPromise) => {
    const input = createReadStream(path)
    input.once('error', rejectPromise)
    input.on('data', (chunk) => hash.update(chunk))
    input.once('end', resolvePromise)
  })
  return hash.digest('hex').toUpperCase()
}
