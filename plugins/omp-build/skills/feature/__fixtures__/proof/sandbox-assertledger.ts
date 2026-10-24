import { STACK } from './sandbox-semctx-base'
import type { Commit, Files, Spec } from './sandbox-types'

const CLAMP_BUG =
  'export function clamp(x, lo, hi) {\n  if (x < lo) return lo\n  if (x > hi) return lo\n  return x\n}\n'
const CLAMP = 'export function clamp(x, lo, hi) {\n  if (x < lo) return lo\n  if (x > hi) return hi\n  return x\n}\n'

export const LEDGER_BASE: Files = {
  '.dev/stack.yml': STACK,
  'assertledger.config.json': `${JSON.stringify(
    {
      adapter: { baseTestFiles: ['test/base.test.js'], executable: 'node', kind: 'node-test' },
      candidateRoots: ['test'],
      framework: 'node:test',
      packageManager: 'npm',
      repository: { exclude: ['.git', '.testforge', 'node_modules'], root: '.' },
      schemaVersion: '1.0.0',
      testCommand: { arguments: ['--test'], executable: 'node' },
    },
    null,
    2,
  )}\n`,
  'package.json': '{\n  "name": "clamp",\n  "type": "module",\n  "private": true\n}\n',
  'src/lib.js': CLAMP_BUG,
  'test/base.test.js':
    "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { clamp } from '../src/lib.js'\ntest('in range', () => assert.equal(clamp(2, 0, 5), 2))\n",
}

export const LEDGER_TESTS = {
  regression:
    "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { clamp } from '../src/lib.js'\ntest('above range clamps to hi', () => assert.equal(clamp(9, 0, 5), 5))\n",
  weak: "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { clamp } from '../src/lib.js'\ntest('below range', () => assert.equal(clamp(-1, 0, 5), 0))\n",
} as const

/** PR number → the branch whose tip is the candidate (`fixed`), with the selected test. */
export const LEDGER_CASES = {
  detection: { pr: 20, branch: 'fix/2-detection', test: 'regression' },
  weak: { pr: 21, branch: 'fix/2-weak', test: 'weak' },
} as const

/** The fix commit of a ledger candidate: `clamp` corrected, with the selected test. */
export const clampFix = (test: keyof typeof LEDGER_TESTS): Commit => ({
  message: 'fix: clamp above range (#2)',
  files: { 'src/lib.js': CLAMP, [`test/${test}.test.js`]: LEDGER_TESTS[test] },
})
/** The comment-only revision of a fixed tree assertledger checks as neutral. */
export const CLAMP_NEUTRAL: Commit = { message: 'chore: comment', files: { 'src/lib.js': `// clamp\n${CLAMP}` } }

export function ledgerSpec(overrides: Partial<Spec> = {}): Spec {
  return {
    base: LEDGER_BASE,
    branches: [
      ...Object.values(LEDGER_CASES).map(({ branch, test }) => ({
        name: branch,
        from: 'main',
        commits: [clampFix(test)],
      })),
      ...Object.values(LEDGER_CASES).map(({ branch }) => ({
        name: `${branch}-neutral`,
        from: branch,
        commits: [CLAMP_NEUTRAL],
      })),
    ],
    issues: [
      { number: 2, title: 'fix: clamp', issueType: 'fix' },
      { number: 3, title: 'feat: clamp', issueType: 'feat' },
      { number: 4, title: 'clamp', issueType: null },
    ],
    prs: Object.values(LEDGER_CASES).map(({ pr, branch }) => ({
      number: pr,
      branch,
      title: 'fix: clamp above range',
      body: 'Closes #2\n',
      closes: [2],
    })),
    ...overrides,
  }
}
