import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Entry points live in the composition root (ADR-0001); output names stay out/{main,preload,renderer}.
export default defineConfig({
  main: {
    build: { rollupOptions: { input: { index: resolve('src/app/main/index.ts') } } },
    plugins: [
      externalizeDepsPlugin({
        // zod is bundled (tree-shaken) like in preload, so it does not ship in app.asar.
        exclude: ['p-queue', 'remark-gfm', 'remark-math', 'remark-parse', 'remark-stringify', 'unified', 'uuid', 'zod']
      })
    ],
    resolve: { alias: { '@app': resolve('src/app'), '@platform': resolve('src/platform'), '@features': resolve('src/features'), '@shared': resolve('src/shared'), '@core': resolve('src/core'), '@runtime': resolve('src/runtime'), '@main': resolve('src/main') } }
  },
  preload: {
    build: { rollupOptions: { input: { index: resolve('src/app/preload/index.ts') } } },
    plugins: [externalizeDepsPlugin({ exclude: ['zod'] })],
    resolve: { alias: { '@app': resolve('src/app'), '@platform': resolve('src/platform'), '@features': resolve('src/features'), '@shared': resolve('src/shared') } }
  },
  renderer: {
    root: resolve('src/app/renderer'),
    build: { rollupOptions: { input: { index: resolve('src/app/renderer/index.html') } } },
    resolve: { alias: { '@app': resolve('src/app'), '@platform': resolve('src/platform'), '@features': resolve('src/features'), '@shared': resolve('src/shared'), '@renderer': resolve('src/renderer') } },
    // The paper archive embeds its cassette model with `?inline`.
    assetsInclude: ['**/*.glb'],
    plugins: [react()]
  }
})
