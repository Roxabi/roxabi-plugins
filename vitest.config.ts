import { defineConfig } from 'vitest/config'

const exclude = [
  '**/node_modules/**',
  // cli/__tests__ use bun:test (not vitest) — run via `bun test` in the cli package
  '**/cli/__tests__/**',
  // worktrees are isolated checkouts — their tests run in their own context
  '**/.claude/worktrees/**',
  '**/archived/**',
]

// A test that forks a real process pays for process startup plus whatever the
// child does — for several of ours, git work in a temp dir. That cost is bounded
// by the runner's disk, not by our code, so on a loaded CI runner it can exceed
// the 5s default priced for an in-process unit test, and the suite fails with a
// timeout on a diff that cannot have caused it (#502).
//
// Membership is carried by the filename. vitest.setup.ts counts the processes a
// file actually forks and fails any unit test that forks one, so a test cannot
// land in the tight budget by accident — including when it forks only through an
// imported helper, which its own source does not reveal.
const INTEGRATION = '**/*.integration.test.?(c|m)[jt]s?(x)'
export const MODEL = '**/*.model.integration.test.?(c|m)[jt]s?(x)'

export default defineConfig({
  test: {
    exclude,
    setupFiles: ['./vitest.setup.ts'],
    // Root-only: vitest runs a root globalSetup once per run, not per project.
    globalSetup: ['./vitest.global-setup.ts'],
    env: {
      // Prevent config.ts from throwing during module evaluation.
      // Tests that need a different value override via process.env or vi.mock.
      GITHUB_REPO: 'Test/test-repo',
    },
    projects: [
      {
        // `extends: true` makes the inherited setup and fixture environment explicit.
        extends: true,
        test: {
          name: 'unit',
          // Concatenated with the inherited `exclude`, not replacing it.
          // Everything that does not fork, on vitest's 5s default: a unit test
          // that hangs must still fail fast, so that default is not raised.
          exclude: [INTEGRATION],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: [INTEGRATION],
          // Model-backed integration cases run only through the explicit local profile.
          exclude: [MODEL],
          // 26x the slowest fork measured locally, 1155ms. Wide enough to absorb
          // a loaded runner, tight enough that a genuinely hung child still
          // fails the job instead of hanging it.
          testTimeout: 30_000,
        },
      },
    ],
  },
})
