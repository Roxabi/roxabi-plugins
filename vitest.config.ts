import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      // cli/__tests__ use bun:test (not vitest) — run via `bun test` in the cli package
      '**/cli/__tests__/**',
    ],
    setupFiles: ['./vitest.setup.ts'],
    env: {
      // Prevent config.ts from throwing during module evaluation.
      // Tests that need a different value override via process.env or vi.mock.
      GITHUB_REPO: 'Test/test-repo',
    },
  },
})
