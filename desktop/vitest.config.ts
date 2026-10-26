import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@app': resolve(__dirname, 'src/app'), '@platform': resolve(__dirname, 'src/platform'), '@features': resolve(__dirname, 'src/features') } },
  // Mirrors the renderer config: the paper archive embeds its cassette model with `?inline`.
  assetsInclude: ['**/*.glb'],
  test: {
    environment: 'node',
    // Windows + coverage instrumentation can exceed the default 5 s for React views.
    testTimeout: 15_000,
    // Bound CPU/memory contention from jsdom + Ant Design on hosted Windows runners.
    maxWorkers: 2,
    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    // Playwright clears test-results, so unit reports use a separate directory.
    outputFile: { junit: './unit-test-results/junit.xml' },
    exclude: ['e2e/**', 'node_modules/**', 'dist/**', 'out/**'],
    coverage: {
      provider: 'v8',
      all: true,
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: './coverage',
      include: [
        'src/{app,platform/*,features/*}/{main,core,runtime,contract}/**/*.{ts,tsx}'
      ],
      exclude: [
        'src/{app,platform/*,features/*}/{renderer,preload,utility}/**',
        'tests/**',
        'e2e/**',
        'out/**',
        'dist/**',
        'coverage/**',
        'release/**',
        '**/generated/**',
        '**/*.d.ts',
        // Electron owns process bootstrap (the Main composition root) and utility-process creation; these
        // adapters have no meaningful unit-test boundary.
        'src/app/main/**',
        'src/platform/rpc/main/electronUtilityFork.ts',
        // These files are type-only contracts after TypeScript erasure.
        'src/platform/files/contract/pathPolicyPort.ts',
        'src/features/library/contract/{artifacts,documentTypes,taskCompute,taskRepository}.ts',
        'src/features/translation/contract/{translationBatch,translationTypes}.ts',
        'src/features/{chat/contract/ragChunk,settings/contract/settingsTypes,parsing/contract/blocks,reader/contract/readerTypes}.ts'
      ],
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 80,
        branches: 75
      }
    }
  }
})
