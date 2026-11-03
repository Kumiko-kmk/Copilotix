import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Entry points live in the composition root (ADR-0001); output names stay out/{main,preload,renderer}.
export default defineConfig(({ command, mode }) => {
  const lite = mode === 'lite'
  // Built side by side, so full-edition E2E keep running against out/ after a Lite build.
  const outRoot = lite && command === 'build' ? 'out-lite' : 'out'
  const define = { __COPILOTIX_LITE__: JSON.stringify(lite) }
  return {
    main: {
      define,
      build: { outDir: `${outRoot}/main`, rollupOptions: { input: { index: resolve('src/app/main/index.ts') } } },
      plugins: [
        externalizeDepsPlugin({
          // zod is bundled (tree-shaken) like in preload, so it does not ship in app.asar.
          exclude: ['p-queue', 'remark-gfm', 'remark-math', 'remark-parse', 'remark-stringify', 'unified', 'uuid', 'zod']
        })
      ],
      resolve: { alias: { '@app': resolve('src/app'), '@platform': resolve('src/platform'), '@features': resolve('src/features') } }
    },
    preload: {
      build: { outDir: `${outRoot}/preload`, rollupOptions: { input: { index: resolve('src/app/preload/index.ts') } } },
      plugins: [externalizeDepsPlugin({ exclude: ['zod'] })],
      resolve: { alias: { '@app': resolve('src/app'), '@platform': resolve('src/platform'), '@features': resolve('src/features') } }
    },
    renderer: {
      root: resolve('src/app/renderer'),
      define,
      build: { outDir: resolve(`${outRoot}/renderer`), rollupOptions: { input: { index: resolve('src/app/renderer/index.html') } } },
      // rehype-katex and the imported stylesheet must use the same KaTeX DOM contract.
      resolve: { dedupe: ['katex'], alias: { '@app': resolve('src/app'), '@platform': resolve('src/platform'), '@features': resolve('src/features') } },
      // The paper archive embeds its cassette model with `?inline`.
      assetsInclude: ['**/*.glb'],
      plugins: [react()]
    }
  }
})
