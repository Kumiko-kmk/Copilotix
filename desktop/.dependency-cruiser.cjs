// Module boundaries from docs/adr/0001-feature-modules.md, run with `pnpm deps`.
// Every rule is an error since M5; `pnpm deps` must report no violations.

const FEATURES = ['library', 'parsing', 'translation', 'reader', 'chat', 'insight', 'zotero', 'settings']

/** Files of one process layer: `<unit>/<layer>/` inside app, platform/<concern> or features/<name>. */
function layer(...names) {
  return `^src/(?:app/(?:${names.join('|')})|(?:platform|features)/[^/]+/(?:${names.join('|')}))/`
}

const ELECTRON = '/node_modules/electron/'
const ENTRY_POINTS = '^src/app/(?:(?:main|preload|utility)/index\\.ts|renderer/main\\.tsx|utility/uninstallCleanupEntry\\.ts)$'
const PUBLIC_ENTRY = '(?:contract/|(?:core|runtime|main|preload|renderer|utility)/index\\.tsx?$)'

module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment: 'ADR-0001 rule 5: no import cycles, type-only imports included. Lazy import() edges (code-split pages; dependency-cruiser reports them as type-import when the module type is also taken with typeof import()) do not form initialization cycles and are not counted.',
      severity: 'error',
      from: {},
      to: { circular: true, viaOnly: { dependencyTypesNot: ['dynamic-import', 'type-import'] } }
    },
    {
      name: 'platform-no-features',
      comment: 'ADR-0001 rule 2: platform is infrastructure and cannot know any feature or the app root.',
      severity: 'error',
      from: { path: '^src/platform/' },
      to: { path: '^src/(?:features|app)/' }
    },
    {
      name: 'app-is-root',
      comment: 'ADR-0001 rule 3: only the composition root imports app/.',
      severity: 'error',
      from: { pathNot: '^src/app/' },
      to: { path: '^src/app/' }
    },
    ...FEATURES.map(feature => ({
      name: `feature-boundary-${feature}`,
      comment: `ADR-0001 rule 1: other modules use only ${feature}/contract or a layer index.ts.`,
      severity: 'error',
      from: { path: '^src/', pathNot: [`^src/features/${feature}/`, '^src/app/'] },
      to: { path: `^src/features/${feature}/`, pathNot: `^src/features/${feature}/${PUBLIC_ENTRY}` }
    })),
    {
      name: 'pure-layer',
      comment: 'contract/ and core/ run in every process: no Node, Electron or process layer.',
      severity: 'error',
      from: { path: layer('contract', 'core') },
      to: { path: [layer('runtime', 'main', 'preload', 'renderer', 'utility'), ELECTRON] }
    },
    {
      name: 'pure-layer-node',
      severity: 'error',
      from: { path: layer('contract', 'core') },
      to: { dependencyTypes: ['core'] }
    },
    {
      name: 'renderer-isolation',
      comment: 'Renderer reaches privileged work only through the preload API.',
      severity: 'error',
      from: { path: layer('renderer') },
      to: { path: [layer('runtime', 'main', 'preload', 'utility'), ELECTRON] }
    },
    {
      name: 'renderer-no-node',
      severity: 'error',
      from: { path: layer('renderer') },
      to: { dependencyTypes: ['core'] }
    },
    {
      name: 'preload-contracts-only',
      severity: 'error',
      from: { path: layer('preload') },
      to: { path: layer('runtime', 'main', 'renderer', 'utility') }
    },
    {
      name: 'main-no-renderer-utility',
      severity: 'error',
      from: { path: layer('main') },
      to: { path: layer('preload', 'renderer', 'utility') }
    },
    {
      name: 'runtime-no-process-layer',
      comment: 'runtime/ is Node code shared by Main and Utility, without Electron.',
      severity: 'error',
      from: { path: layer('runtime') },
      to: { path: [layer('main', 'preload', 'renderer', 'utility'), ELECTRON] }
    },
    {
      name: 'utility-no-main-renderer',
      comment: 'Utility is a separate Node process: no Electron main APIs or renderer code.',
      severity: 'error',
      from: { path: layer('utility') },
      to: { path: [layer('main', 'preload', 'renderer'), ELECTRON] }
    },
    {
      name: 'not-reachable',
      comment: 'Source no process entry reaches is dead code (tests alone do not keep it alive).',
      severity: 'info',
      from: { path: ENTRY_POINTS },
      to: { path: '^src/', pathNot: ['\\.d\\.ts$', ENTRY_POINTS], reachable: false }
    }
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '^(?:out|node_modules)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: { extensions: ['.ts', '.tsx', '.mjs', '.js', '.d.ts'] },
    reporterOptions: { text: { highlightFocused: true } }
  }
}
