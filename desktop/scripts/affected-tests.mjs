// Runs only the tests affected by changes since a base ref, plus a small always-run set.
//   node scripts/affected-tests.mjs unit|e2e [--base <ref>] [--list]
// Base: --base, else COPILOTIX_TEST_BASE, else merge-base(HEAD, master). Committed, staged,
// unstaged and untracked files all count. Toolchain changes, or a base that cannot be
// resolved, select everything; `pnpm desktop:test:full` / `test:e2e:full` stay explicit full runs.
import { execFileSync, spawnSync } from 'node:child_process'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: DESKTOP, encoding: 'utf8' }).trim()

/** Data safety, persistence, IPC origin and cancel/recovery regressions run on every change. */
export const REQUIRED_UNIT_TESTS = [
  'tests/ipcContracts.test.ts', 'tests/platform/v2Database.test.ts', 'tests/platform/sqliteJobRepository.test.ts',
  'tests/platform/jobScheduler.test.ts', 'tests/platform/pathPolicy.test.ts', 'tests/libraryMaintenance.test.ts', 'tests/platform/uninstallCleanup.test.ts'
]
/** Changes that can affect any test without appearing in its import graph. */
const FULL_TRIGGERS = [
  /^(?:desktop\/)?package\.json$/u, /^pnpm-(?:lock|workspace)\.yaml$/u, /^\.github\/workflows\//u,
  /^desktop\/(?:vitest|electron\.vite|utility\.vite|playwright)\.config\.ts$/u, /^desktop\/tsconfig[^/]*\.json$/u,
  /^desktop\/scripts\/affected-tests\.mjs$/u
]
/** Specs import only e2e helpers, so source paths map to the flows they exercise. */
const E2E_ALL = [/^desktop\/e2e\/(?:helpers|launchPolicy)\.ts$/u, /^desktop\/src\/preload\//u, /^desktop\/src\/(?:app|platform\/(?:ipc|rpc))\//u, /^desktop\/src\/main\/index\.ts$/u, /^desktop\/src\/renderer\/(?:App|main)\.tsx$/u]
const E2E_MAP = [
  [/^desktop\/src\/renderer\/(?:components\/(?:Reader(?!Chat|Figure)|MarkdownPane|MarkdownMinimap|PdfPane|DocumentLifecycle)|reader(?!Figure))/u, ['reader', 'qa-fixes']],
  [/(?:ReaderFigure|readerFigureGroups|figureArtifact|figureInsight)/u, ['reader-figures']],
  [/(?:ReaderChatPanel|paperChat|\/rag)/u, ['paper-chat']],
  [/(?:paperArchive|LibraryPage|ArchiveDetail|ArchiveText|lineRedaction|libraryCategories|useArchivePreparation)/u, ['paper-archive', 'archive-layout', 'archive-math']],
  [/(?:paperInsight|paperBrief|PaperInsight)/u, ['paper-insight', 'archive-math']],
  [/(?:SettingsPage|AppNavigation|theme\.ts|settingsService|storageService)/u, ['ui-chrome', 'qa-fixes']],
  [/(?:window|TitleBar|EdgeDock)/iu, ['window-controls']],
  [/(?:libraryMaintenance|libraryAccessGate|LibraryManagement)/u, ['library']],
  [/(?:import|HomePage|documentService|taskService)/iu, ['qa-fixes']]
]

function git(...args) { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }) }

function resolveBase(explicit) {
  const candidate = explicit || process.env.COPILOTIX_TEST_BASE
  // A new branch push reports an all-zero "before"; nothing to compare against means a full run.
  if (candidate) {
    if (/^0+$/u.test(candidate)) return null
    try { git('rev-parse', '--verify', `${candidate}^{commit}`); return candidate } catch { return null }
  }
  for (const ref of ['master', 'origin/master']) {
    try { return git('merge-base', 'HEAD', ref).trim() } catch { /* try the next ref */ }
  }
  return null
}

function changedFiles(base) {
  const lines = git('diff', '--name-only', base) + git('ls-files', '--others', '--exclude-standard')
  return [...new Set(lines.split('\n').map(line => line.trim().replaceAll('\\', '/')).filter(Boolean))]
}

const VITEST = join(DESKTOP, 'node_modules/vitest/vitest.mjs')
const PLAYWRIGHT = join(DESKTOP, 'node_modules/@playwright/test/cli.js')
function run(cli, args) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: DESKTOP, stdio: 'inherit' })
  process.exit(result.status ?? 1)
}

const argv = process.argv.slice(2)
const mode = argv[0] === 'e2e' ? 'e2e' : 'unit'
const listOnly = argv.includes('--list')
const baseIndex = argv.indexOf('--base')
const base = resolveBase(baseIndex >= 0 ? argv[baseIndex + 1] : undefined)
const files = base ? changedFiles(base) : []
const full = !base || files.some(file => FULL_TRIGGERS.some(pattern => pattern.test(file)))
console.log(`[affected-tests] ${mode} base=${base ?? 'unresolved'} changed=${files.length} ${full ? 'FULL' : 'affected only'}`)

if (mode === 'unit') {
  if (full) {
    if (!listOnly) run(VITEST, ['run'])
    process.exit(0)
  }
  // vitest follows each test's import graph (.test.ts, .test.tsx and .test.mjs alike).
  const listed = spawnSync(process.execPath, [VITEST, 'list', '--changed', base, '--filesOnly', '--json'], { cwd: DESKTOP, encoding: 'utf8' })
  const json = listed.stdout.slice(listed.stdout.indexOf('['))
  if (listed.status !== 0 || !json.startsWith('[')) { process.stderr.write(listed.stderr); process.exit(listed.status || 1) }
  const affected = JSON.parse(json).map(entry => relative(DESKTOP, entry.file).replaceAll('\\', '/'))
  const selected = [...new Set([...REQUIRED_UNIT_TESTS, ...affected])]
  console.log(`[affected-tests] ${affected.length} affected + ${REQUIRED_UNIT_TESTS.length} required → ${selected.length} files`)
  for (const file of selected) console.log(`  ${file}`)
  if (!listOnly) run(VITEST, ['run', ...selected])
} else {
  const all = full || files.some(file => E2E_ALL.some(pattern => pattern.test(file)))
  const specs = new Set(['smoke'])
  for (const file of files) {
    const own = /^desktop\/e2e\/([\w-]+)\.spec\.ts$/u.exec(file)
    if (own) specs.add(own[1])
    if (!file.startsWith('desktop/src/')) continue
    for (const [pattern, names] of E2E_MAP) if (pattern.test(file)) names.forEach(name => specs.add(name))
  }
  const selected = all ? [] : [...specs].map(name => `e2e/${name}.spec.ts`)
  console.log(`[affected-tests] e2e: ${all ? 'all specs' : selected.join(' ')}`)
  if (!listOnly) run(PLAYWRIGHT, ['test', ...selected, '--grep-invert', 'hardened packaged'])
}
