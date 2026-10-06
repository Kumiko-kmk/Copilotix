import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared'), '@core': resolve(__dirname, 'src/core'), '@main': resolve(__dirname, 'src/main') } },
  test: {
    environment: 'node',
    // Windows + coverage instrumentation can exceed the default 5 s for React views.
    testTimeout: 15_000,
    // Bound CPU/memory contention from jsdom + Ant Design on hosted Windows runners.
    maxWorkers: process.env.CI ? 2 : undefined,
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
        'src/shared/**/*.ts',
        'src/shared/**/*.tsx'
      ],
      exclude: [
        'src/renderer/**',
        'src/preload/**',
        'src/utility/**',
        'tests/**',
        'e2e/**',
        'out/**',
        'dist/**',
        'coverage/**',
        'release/**',
        '**/generated/**',
        '**/*.d.ts',
        // Electron owns process bootstrap and utility-process creation; these
        // two adapters have no meaningful unit-test boundary.
        'src/main/index.ts',
        'src/main/electronUtilityFork.ts',
        // These files are type-only contracts after TypeScript erasure.
        'src/core/ports.ts',
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
