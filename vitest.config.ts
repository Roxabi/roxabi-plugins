import { defineConfig } from 'vitest/config'

const exclude = [
  '**/node_modules/**',
  // cli/__tests__ use bun:test (not vitest) — run via `bun test` in the cli package
  '**/cli/__tests__/**',
  // worktrees are isolated checkouts — their tests run in their own context
  '**/.claude/worktrees/**',
]

// A test that forks a real process pays for process startup plus whatever the
// child does — for several of ours, git work in a temp dir. That cost is bounded
// by the runner's disk, not by our code, so on a loaded CI runner it can exceed
// the 5s default priced for an in-process unit test, and the suite fails with a
// timeout on a diff that cannot have caused it (#502).
//
// Membership is carried by the filename and enforced by
// tools/__tests__/integration-test-naming.test.ts, so a new forking test cannot
// silently land in the tight budget.
const INTEGRATION = '**/*.integration.test.?(c|m)[jt]s?(x)'

export default defineConfig({
  test: {
    exclude,
    setupFiles: ['./vitest.setup.ts'],
    env: {
      // Prevent config.ts from throwing during module evaluation.
      // Tests that need a different value override via process.env or vi.mock.
      GITHUB_REPO: 'Test/test-repo',
    },
    projects: [
      {
        // `extends: true` is explicit: inline projects only inherit by default
        // from vitest 5, and this repo is on 4.x.
        extends: true,
        test: {
          name: 'unit',
          // Everything that does not fork, on vitest's 5s default. A unit test
          // that hangs must still fail fast — that default is deliberately
          // not raised.
          exclude: [...exclude, INTEGRATION],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: [INTEGRATION],
          // 26x the slowest fork measured locally (1155ms, lib-worktree). Wide
          // enough to absorb a loaded runner, tight enough that a genuinely
          // hung child still fails the job instead of hanging it.
          testTimeout: 30_000,
        },
      },
    ],
  },
})
