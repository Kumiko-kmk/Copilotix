import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@app': resolve(__dirname, 'src/app'), '@platform': resolve(__dirname, 'src/platform'), '@features': resolve(__dirname, 'src/features'), '@shared': resolve(__dirname, 'src/shared'), '@core': resolve(__dirname, 'src/core'), '@runtime': resolve(__dirname, 'src/runtime'), '@main': resolve(__dirname, 'src/main'), '@renderer': resolve(__dirname, 'src/renderer') } },
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
        'src/main/**/*.ts',
        'src/main/**/*.tsx',
        'src/core/**/*.ts',
        'src/core/**/*.tsx',
        'src/runtime/**/*.ts',
        'src/shared/**/*.ts',
        'src/shared/**/*.tsx',
        // ADR-0001 layout: the same process layers as above.
        'src/{app,platform/*,features/*}/{main,core,runtime,contract}/**/*.{ts,tsx}'
      ],
      exclude: [
        'src/renderer/**',
        'src/preload/**',
        'src/utility/**',
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
        'src/core/ports.ts',
        'src/platform/files/contract/pathPolicyPort.ts',
        'src/core/types.ts',
        'src/shared/types.ts',
        'src/main/taskRepositoryCompat.ts'
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
