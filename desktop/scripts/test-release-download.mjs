import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import extract from 'extract-zip'
import { build, createTargets, Platform } from 'electron-builder'
import { buildStandaloneUninstaller } from './build-uninstall-launcher.mjs'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repo = dirname(desktop)
const args = process.argv.slice(2)
const release = resolve(args.find((arg) => !arg.startsWith('--')) ?? join(repo, 'release'))
const install = args.includes('--install') || args.includes('--install-only')
const download = !args.includes('--install-only')
const ownedRoot = join(tmpdir(), `copilotix-release-acceptance-${randomUUID()}`)
async function assertOwned(path) {
  const rel = relative(ownedRoot, resolve(path))
  assert(rel && !rel.startsWith('..') && !resolve(path).startsWith('\\\\'))
  assert(!(await lstat(ownedRoot)).isSymbolicLink())
  assert(!(await lstat(path)).isSymbolicLink())
}
const passes = []
const pass = (name) => { passes.push(name); console.log(`PASS: ${name}`) }
const hash = async (path) => {
  const digest = createHash('sha256')
  for await (const bytes of createReadStream(path)) digest.update(bytes)
  return digest.digest('hex').toUpperCase()
}
function run(file, argv, timeout = 120_000) {
  const result = spawnSync(file, argv, { windowsHide: true, encoding: 'utf8', timeout })
  if (result.error) throw result.error
  assert.equal(result.status, 0, `${basename(file)} failed: ${result.stdout} ${result.stderr}`)
  return result.stdout
}
function protectedState() {
  // Read-only: never touch a real install, credential or application database.
  return run('powershell.exe', ['-NoProfile', '-Command', String.raw`
$ErrorActionPreference='Stop'
$roots=@('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')
$registrations=@(foreach($root in $roots){if(Test-Path -LiteralPath $root){Get-ChildItem -LiteralPath $root | Get-ItemProperty | Where-Object {$_.PSObject.Properties['DisplayName'] -and $_.DisplayName -like 'Copilotix*' -and $_.DisplayName -notlike '*Acceptance*'} | Select-Object PSChildName,DisplayName,InstallLocation,UninstallString}})
$installed=(Get-ItemProperty -LiteralPath 'HKCU:\Software\14328922-5660-531d-8d5f-b169b5a958e0' -ErrorAction SilentlyContinue).InstallLocation
$paths=@((Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Copilotix-Translation-v2\copilotix-desktop-v2.sqlite3')); if($installed){$paths+=Join-Path $installed 'Copilotix.exe';$paths+=Join-Path $installed 'resources\app.asar'}
$files=@(foreach($path in $paths){if(Test-Path -LiteralPath $path){$stream=[IO.File]::OpenRead($path); try { $hash=[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($stream)).Replace('-',''); [ordered]@{Path=$path;Hash=$hash} } finally { $stream.Dispose() }}})
[ordered]@{registrations=$registrations;files=$files} | ConvertTo-Json -Depth 8 -Compress
`]).trim()
}
const registryKey = (guid) => ['HKCU', 'Software', 'Microsoft', 'Windows', 'CurrentVersion', 'Uninstall', guid].join(String.fromCharCode(92))
function registryState(guid) {
  return run('reg.exe', ['query', registryKey(guid), '/v', 'DisplayName'])
}

const before = protectedState()
await mkdir(ownedRoot)
let completed = false
let acceptanceManifest
try {
  const manifest = JSON.parse(await readFile(join(release, 'advanced/release-manifest.json'), 'utf8'))
  acceptanceManifest = manifest
  if (download) {
    const zip = resolve(release, manifest.artifactDirectory ?? '.', manifest.transport.file)
    assert.equal(await hash(zip), manifest.transport.sha256.toUpperCase(), 'Release ZIP hash mismatch')
    const server = createServer((request, response) => {
      if (request.url !== '/release.zip') { response.writeHead(404).end(); return }
      response.writeHead(200, { 'Content-Type': 'application/zip' })
      createReadStream(zip).pipe(response)
    })
    await new Promise((done) => server.listen(0, '127.0.0.1', done))
    const downloaded = join(ownedRoot, 'download.zip')
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/release.zip`)
      assert.equal(response.status, 200)
      await pipeline(Readable.fromWeb(response.body), createWriteStream(downloaded))
    } finally { await new Promise((done) => server.close(done)) }
    assert.equal(await hash(downloaded), manifest.transport.sha256.toUpperCase(), 'Downloaded ZIP changed')
    pass('loopback HTTP download and SHA256 integrity')
    const extracted = join(ownedRoot, '解壓 release')
    await extract(downloaded, { dir: extracted })
    const roots = await readdir(extracted)
    assert.equal(roots.length, 1, 'ZIP should contain one beginner-friendly release directory')
    const bundle = join(extracted, roots[0])
    const entries = await readdir(bundle)
    assert(entries.includes('uninstall.exe') && entries.includes('advanced'))
    const compact = manifest.schemaVersion >= 5
    if (compact) {
      assert.equal(manifest.distribution, 'compact-setup')
      assert(!entries.includes('program'), 'Compact ZIP must not duplicate the program already inside Setup')
      assert.equal(entries.length, 4, 'Compact ZIP should only contain Setup, uninstall.exe, instructions and advanced')
    } else assert(entries.includes('program'))
    const setup = entries.find((entry) => entry === 'setup.exe')
    assert(setup && entries.some((entry) => entry.endsWith('.txt')))
    assert.equal(await hash(join(bundle, setup)), manifest.installer.sha256.toUpperCase())
    if (!compact) {
      assert.equal(await hash(join(bundle, 'program/Copilotix.exe')), manifest.runtime.sha256.toUpperCase())
      assert.equal(await hash(join(bundle, 'program/resources/app.asar')), manifest.runtime.appAsarSha256.toUpperCase())
    }
    assert.equal(await hash(join(bundle, 'uninstall.exe')), manifest.uninstaller.sha256.toUpperCase())
    const advanced = await readdir(join(bundle, 'advanced'))
    assert(advanced.includes('SHA256SUMS.txt') && advanced.includes('bundle-manifest.json'))
    pass(compact ? 'compact bundle has Setup, uninstaller and instructions without duplicate program' : 'downloaded bundle has Setup, uninstaller, complete program and instructions')
    await assertOwned(downloaded)
    await assertOwned(extracted)
    await rm(downloaded)
    await rm(extracted, { recursive: true })
    pass('downloaded archive and extracted directory delete successfully')
  }
  if (install) {
    assert.equal(process.platform, 'win32')
    const guid = randomUUID()
    const name = `Copilotix Acceptance ${guid.slice(0, 8)}`
    const runtime = manifest.schemaVersion >= 5
      ? resolve(release, manifest.runtimeArtifactDirectory)
      : manifest.schemaVersion >= 4
        ? join(release, manifest.runtime.directory)
        : resolve(release, manifest.artifactDirectory ?? '.', manifest.runtime.directory)
    assert.equal(await hash(join(runtime, 'Copilotix.exe')), manifest.runtime.sha256.toUpperCase())
    assert.equal(await hash(join(runtime, 'resources/app.asar')), manifest.runtime.appAsarSha256.toUpperCase())
    const output = join(ownedRoot, 'builder')
    await build({
      projectDir: desktop, prepackaged: runtime,
      targets: createTargets([Platform.WINDOWS], 'nsis', 'x64'),
      config: {
        appId: `com.copilotix.acceptance.${guid}`, productName: name,
        forceCodeSigning: false, afterPack: join(desktop, 'scripts/after-pack.mjs'), directories: { output },
        nsis: { guid, artifactName: 'acceptance-setup.exe', uninstallDisplayName: name,
          createDesktopShortcut: false, createStartMenuShortcut: false, runAfterFinish: false,
          shortcutName: name, include: join(desktop, 'resources/installer.nsh') }
      }
    })
    // Observe the real controls using the unique acceptance GUID, then cancel
    // before installation. This cannot alter the user's registered install.
    await mkdir(join(output, 'advanced'), { recursive: true })
    await writeFile(join(output, 'advanced/release-manifest.json'), JSON.stringify({
      ...manifest,
      installer: { ...manifest.installer, file: 'acceptance-setup.exe', sha256: (await hash(join(output, 'acceptance-setup.exe'))).toLowerCase() }
    }))
    run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      join(desktop, 'scripts/test-installer-wizard.ps1'), '-ReleaseDirectory', output,
      '-EvidenceDirectory', join(desktop, 'test-artifacts/isolated-desktop-shortcut'), '-Language', 'English'])
    pass('isolated native wizard defaults desktop shortcut checkbox to checked, allows toggling and cancels without installation')
    const destination = join(ownedRoot, '實際安裝 path', 'Copilotix')
    run(join(output, 'acceptance-setup.exe'), ['/S', `/D=${destination}`])
    assert.equal(await hash(join(destination, 'Copilotix.exe')), manifest.runtime.sha256.toUpperCase())
    assert.equal(await hash(join(destination, 'resources/app.asar')), manifest.runtime.appAsarSha256.toUpperCase())
    assert(registryState(guid).includes(name))
    const pkg = JSON.parse(await readFile(join(desktop, 'package.json'), 'utf8'))
    run(process.execPath, [join(desktop, 'scripts/installer-core-smoke.mjs'), join(destination, 'Copilotix.exe'), manifest.version, pkg.devDependencies.electron])
    pass('same runtime installs in isolated Unicode path, registers unique GUID and starts core')
    const launcher = join(ownedRoot, 'downloaded-launcher', 'uninstall.exe')
    await buildStandaloneUninstaller({ outputPath: launcher, installGuid: guid })
    run(launcher, ['/S'])
    await assert.rejects(stat(join(destination, 'Copilotix.exe')), { code: 'ENOENT' })
    const removed = spawnSync('reg.exe', ['query', registryKey(guid)], { windowsHide: true })
    assert.notEqual(removed.status, 0, 'Isolated uninstall registration survived')
    pass('downloaded uninstall launcher dispatches real NSIS and removes isolated program/registration')
  }
  assert.equal(protectedState(), before, 'Existing user install or database changed')
  pass('existing user program, uninstall registration and database remain unchanged')
  completed = true
} finally {
  const report = join(desktop, 'test-artifacts', 'release-download-acceptance.json')
  await mkdir(dirname(report), { recursive: true })
  await writeFile(report, JSON.stringify({ completed, passes, release, ownedRoot, schemaVersion: acceptanceManifest?.schemaVersion, distribution: acceptanceManifest?.distribution, runtimeSha256: acceptanceManifest?.runtime.sha256, appAsarSha256: acceptanceManifest?.runtime.appAsarSha256, testedAt: new Date().toISOString() }, null, 2))
  if (completed) {
    assert.equal(dirname(resolve(ownedRoot)), resolve(tmpdir()))
    assert(/^copilotix-release-acceptance-[a-f0-9-]{36}$/u.test(basename(ownedRoot)))
    assert(!relative(tmpdir(), ownedRoot).includes(`..${sep}`))
    assert(!(await lstat(ownedRoot)).isSymbolicLink())
    await rm(ownedRoot, { recursive: true })
  } else console.error(`Owned acceptance files retained for diagnosis: ${ownedRoot}`)
}
