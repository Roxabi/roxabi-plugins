/**
 * Disposable repositories for the landing admission (#768): a bare origin, a
 * principal checkout, the stateful `gh-simulator.ts` as `gh`, and commits with a
 * fixed identity and date, so every commit sha is the same on every machine.
 * `capture.ts` runs the real producers against these repositories once; the
 * integration test rebuilds them and lands against the conserved records.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

export const SIM = path.resolve(import.meta.dirname, '..', '..', 'gh-simulator.ts')
export const WORKFLOW = path.resolve(import.meta.dirname, '..', '..', 'goal-scenario-workflow.ts')
export const ACQUIRE = path.resolve(import.meta.dirname, '..', '..', 'proof-acquire.ts')

/** File contents by path; `null` deletes (a directory recursively). */
export type Files = Record<string, string | null>
export type Commit = { message: string; files: Files }
export type BranchSpec = { name: string; from: string; commits: Commit[] }
/** `base` is the PR's base branch (`main` when omitted). */
export type PrSpec = { number: number; branch: string; title: string; body: string; closes: number[]; base?: string }
export type IssueSpec = { number: number; title: string; issueType?: string | null }
export type Spec = {
  base: Files
  /** Side refs pushed to origin (`refs/heads/<name>`), e.g. a neutral revision. */
  branches: BranchSpec[]
  issues: IssueSpec[]
  prs: PrSpec[]
  /** The principal checkout's directory name; trailing whitespace is kept. */
  principalName?: string
  /** Files written into the principal checkout and never committed (the operator's ignored state). */
  principalFiles?: Record<string, string>
  /** Extra PATH entries before the simulator's bin. */
  path?: string[]
}

type SimComment = { author: string; body: string; createdAt?: string }
type SimPull = {
  number: number
  body: string
  state: string
  headRefName: string
  headRefOid: string
  labels: string[]
  autoMerge: { enabledAt: string; matchHeadCommit?: string } | null
  comments: SimComment[]
  lastEditedAt?: string | null
  closes: number[]
}
export type SimState = {
  viewer: string
  prs: Record<string, SimPull>
  issues: Record<string, { title: string; labels: string[]; issueType?: string | null; comments: SimComment[] }>
  checks: Record<
    string,
    { name: string; status: string; conclusion: string; workflowName: string; startedAt: string }[]
  >
  calls: string[][]
}

export type Box = {
  root: string
  origin: string
  principal: string
  stateFile: string
  env: NodeJS.ProcessEnv
  /** Tip of every branch, `main` included. */
  sha: Record<string, string>
}

const DATE = '2026-01-01T00:00:00Z'

export function git(box: Pick<Box, 'env'>, cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    env: box.env,
    encoding: 'utf8',
  }).replace(/\n$/, '')
}

function write(dir: string, files: Files, box: Box): void {
  for (const [file, content] of Object.entries(files)) {
    const at = path.join(dir, file)
    if (content === null) {
      git(box, dir, ['rm', '-r', '-q', '--', file])
      continue
    }
    mkdirSync(path.dirname(at), { recursive: true })
    writeFileSync(at, content)
  }
}

export function sandbox(spec: Spec): Box {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'omp-proof-')))
  const origin = path.join(root, 'origin.git')
  const principal = path.join(root, spec.principalName ?? 'principal')
  const bin = path.join(root, 'bin')
  const stateFile = path.join(root, 'gh-state.json')
  mkdirSync(bin)
  symlinkSync(SIM, path.join(bin, 'gh'))
  chmodSync(SIM, 0o755)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: [...(spec.path ?? []), bin, process.env.PATH].join(':'),
    HOME: root,
    GH_SIM_STATE: stateFile,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_DATE: DATE,
    GIT_COMMITTER_DATE: DATE,
  }
  for (const key of Object.keys(env)) {
    if (
      key.startsWith('GIT_') &&
      !['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_AUTHOR_DATE', 'GIT_COMMITTER_DATE'].includes(key)
    ) {
      delete env[key]
    }
  }
  const box: Box = { root, origin, principal, stateFile, env, sha: {} }
  git(box, root, ['init', '-q', '--bare', origin])
  git(box, root, ['init', '-q', '-b', 'main', principal])
  write(principal, spec.base, box)
  git(box, principal, ['add', '-A'])
  git(box, principal, ['commit', '-qm', 'chore: base'])
  git(box, principal, ['remote', 'add', 'origin', origin])
  git(box, principal, ['push', '-q', '-u', 'origin', 'main'])
  box.sha.main = git(box, principal, ['rev-parse', 'HEAD'])
  for (const branch of spec.branches) {
    git(box, principal, ['checkout', '-q', '-b', branch.name, box.sha[branch.from] ?? branch.from])
    for (const commit of branch.commits) {
      write(principal, commit.files, box)
      git(box, principal, ['add', '-A'])
      git(box, principal, ['commit', '-qm', commit.message])
    }
    box.sha[branch.name] = git(box, principal, ['rev-parse', 'HEAD'])
    git(box, principal, ['push', '-q', 'origin', branch.name])
  }
  git(box, principal, ['checkout', '-q', 'main'])
  git(box, principal, ['fetch', '-q', 'origin'])
  for (const [file, content] of Object.entries(spec.principalFiles ?? {})) {
    mkdirSync(path.dirname(path.join(principal, file)), { recursive: true })
    writeFileSync(path.join(principal, file), content)
  }
  const issues: Record<string, unknown> = {}
  for (const issue of spec.issues) {
    issues[issue.number] = {
      number: issue.number,
      title: issue.title,
      body: '## Acceptance criteria\n\n- [ ] lands\n',
      state: 'OPEN',
      author: 'operator',
      labels: ['size:F-lite'],
      comments: [],
      subIssues: [],
      blockedBy: [],
      issueType: issue.issueType ?? null,
    }
  }
  const prs: Record<string, unknown> = {}
  for (const pr of spec.prs) {
    prs[pr.number] = {
      number: pr.number,
      title: pr.title,
      body: pr.body,
      state: 'OPEN',
      headRefName: pr.branch,
      baseRefName: pr.base ?? 'main',
      headRefOid: box.sha[pr.branch],
      isCrossRepository: false,
      labels: [],
      autoMerge: null,
      mergeCommit: null,
      mergedAt: null,
      comments: [],
      closes: pr.closes,
    }
  }
  writeFileSync(
    stateFile,
    JSON.stringify(
      {
        viewer: 'operator',
        owner: 'acme',
        name: 'app',
        defaultBranch: 'main',
        origin,
        requiredChecks: ['ci'],
        nextPr: 100,
        clock: 0,
        issues,
        prs,
        checks: {},
        events: {},
        calls: [],
      },
      null,
      2,
    ),
  )
  return box
}

export function readSim(box: Box): SimState {
  return JSON.parse(readFileSync(box.stateFile, 'utf8')) as SimState
}

export function writeSim(box: Box, mutate: (state: SimState) => void): void {
  const state = readSim(box)
  mutate(state)
  writeFileSync(box.stateFile, JSON.stringify(state, null, 2))
}

/** A linked worktree of the principal, detached at `sha`. */
export function worktree(box: Box, name: string, sha: string): string {
  const dir = path.join(box.root, name)
  git(box, box.principal, ['worktree', 'add', '-q', '--detach', dir, sha])
  return dir
}

// ---------------------------------------------------------------------------
// Semctx: a configured repository and one PR per native result
// ---------------------------------------------------------------------------

/** `semctx setup`'s config.json (0.4.2), verbatim: Semctx validates it against its schema. */
export const SEMCTX_CONFIG = `${JSON.stringify(
  {
    include: ['src/**/*.ts'],
    exclude: ['node_modules', 'dist', '.semctx', '.git', 'coverage'],
    docsDirs: ['docs'],
    migrationsDirs: ['migrations'],
    testGlobs: ['**/*.test.ts', '**/*.spec.ts', 'test/**/*.ts'],
    semanticProvider: 'none',
    blockingRules: [
      {
        id: 'invariant-needs-test',
        description: 'A change touching an invariant-constrained symbol must be covered by a test.',
        when: 'invariant_touched_without_test',
        severity: 'block',
        tier: 'strict',
      },
      {
        id: 'critical-contract-needs-test',
        description:
          'A change to a critical exported contract (tagged `critical`/`security`) must be covered by a test.',
        when: 'critical_contract_changed_without_test',
        severity: 'block',
        tier: 'strict',
      },
      {
        id: 'security-needs-verification',
        description: 'A security-surface change needs an explicit verification.',
        when: 'security_surface_without_verification',
        severity: 'block',
        tier: 'strict',
      },
      {
        id: 'contract-needs-test',
        description: 'A change to an exported contract should be covered by a contract test.',
        when: 'contract_changed_without_test',
        severity: 'warn',
        tier: 'advisory',
      },
      {
        id: 'contradiction-unresolved',
        description: 'An unresolved contradiction in touched sources should be surfaced.',
        when: 'contradiction_unresolved',
        severity: 'warn',
        tier: 'advisory',
      },
    ],
    version: 1,
  },
  null,
  2,
)}\n`

export const STACK = ['landing:', '  mode: native', '  required_checks:', '    - ci', ''].join('\n')
/** The same landing, with an e2e command: a ui-manual-only gap is never justified then. */
export const STACK_E2E = `${STACK}commands:\n  test_e2e: bun run e2e\n`

const ADD = 'export function add(a: number, b: number): number {\n  return a + b\n}\n'
const FINITE_ADD =
  'export function add(a: number, b: number): number {\n  if (!Number.isFinite(a) || !Number.isFinite(b)) throw new RangeError("finite only")\n  return a + b\n}\n'
const evidence = (status: string) =>
  `evidence proof.fx.add-test\n  statement: the add test runs\n  status: ${status}\n  link: test:src/a.test.ts\n`
const contract = (lines: string[]) =>
  ['change change.fx.add', '  statement: Harden add', '  status: active', '  provenance: author', ...lines, ''].join(
    '\n',
  )
const SERVES = '  serves: goal.fx.add'
const PRESERVES = '  preserves: invariant.fx.add-sum'
const REQUIRES = '  requires_evidence: proof.fx.add-test'
const LINK = '  link: file:src/a.ts'
const CONTRACT = '.semctx/semantic/changes/change.fx.add.sem'
const EVIDENCE = '.semctx/semantic/evidence.sem'

export const SEMCTX_BASE: Files = {
  '.gitignore': '.semctx/*\n!.semctx/semantic/\n!.semctx/config.json\n',
  '.dev/stack.yml': STACK,
  '.semctx/config.json': SEMCTX_CONFIG,
  '.semctx/semantic/goals.sem': 'goal goal.fx.add\n  statement: add returns the sum\n',
  '.semctx/semantic/invariants.sem':
    'invariant invariant.fx.add-sum\n  rule: add(a, b) equals a + b\n  serves: goal.fx.add\n  link: sym:function:src/a.ts:add\n',
  [EVIDENCE]: evidence('declared'),
  'src/a.ts': ADD,
  'src/a.test.ts':
    "import { expect, test } from 'bun:test'\nimport { add } from './a'\ntest('add', () => expect(add(1, 2)).toBe(3))\n",
}

/**
 * PR number → the branch whose tip is the candidate. Native results: PARTIAL
 * (evidence pending), VERIFIED, PARTIAL with lifecycle `draft`, PARTIAL with
 * lifecycle `verified` (a forced close), VERIFIED with no required evidence,
 * a non-change block under `changes/` that acquisition cannot record, PARTIAL
 * with an e2e command, and PARTIAL on a `release` base that declares an e2e
 * command the candidate deletes. On a `legacy` base that holds a verified
 * contract: a candidate that only modifies it (never recorded), and one that
 * adds its own and modifies the old one. On a `stray` base whose `changes/`
 * holds a file with no change: a VERIFIED candidate that declares another
 * active change outside `changes/`, so the counts still match. A VERIFIED
 * change whose statement is long enough that its record exceeds one comment.
 * And PARTIAL under a `stack` the candidate commits besides its base's: an e2e
 * command left blank or empty declares none, and a stack that is not a map, or
 * whose commands are a list, cannot be read.
 */
export const SEMCTX_CASES = {
  partial: { pr: 10, branch: 'fix/1-partial' },
  verified: { pr: 11, branch: 'fix/1-verified' },
  draft: { pr: 12, branch: 'fix/1-draft' },
  closed: { pr: 13, branch: 'fix/1-closed' },
  vacuous: { pr: 14, branch: 'fix/1-vacuous' },
  mixed: { pr: 15, branch: 'fix/1-mixed' },
  e2e: { pr: 16, branch: 'fix/1-e2e' },
  e2eDeleted: { pr: 19, branch: 'fix/1-e2e-deleted', base: 'release' },
  modified: { pr: 26, branch: 'fix/1-modified', base: 'legacy' },
  amended: { pr: 27, branch: 'fix/1-amended', base: 'legacy' },
  hidden: { pr: 28, branch: 'fix/1-hidden', base: 'stray' },
  large: { pr: 29, branch: 'fix/1-large' },
  e2eBlank: { pr: 31, branch: 'fix/1-e2e-blank', stack: `${STACK}commands:\n  test_e2e: ' '\n` },
  e2eNull: { pr: 32, branch: 'fix/1-e2e-null', stack: `${STACK}commands:\n  test_e2e:\n` },
  stackList: { pr: 33, branch: 'fix/1-stack-list', stack: '- landing\n' },
  commandList: { pr: 34, branch: 'fix/1-command-list', stack: `${STACK}commands:\n  - bun run e2e\n` },
  mixedResults: { pr: 35, branch: 'fix/1-mixed-results', base: 'legacy' },
} as const

const OLD_CONTRACT = '.semctx/semantic/changes/change.fx.old.sem'
const old = (statement: string) =>
  [
    'change change.fx.old',
    `  statement: ${statement}`,
    '  status: verified',
    '  provenance: author',
    SERVES,
    PRESERVES,
    '  requires_evidence: proof.fx.old-test',
    LINK,
    '',
  ].join('\n')

const fixWith = (lines: string[], extra: Files = {}): Commit => ({
  message: 'fix: finite add (#1)',
  files: { [CONTRACT]: contract(lines), 'src/a.ts': FINITE_ADD, ...extra },
})
const fix = fixWith([SERVES, PRESERVES, REQUIRES, LINK])
const proven: Commit = { message: 'test: add proven (#1)', files: { [EVIDENCE]: evidence('tested') } }

export function semctxSpec(overrides: Partial<Spec> = {}): Spec {
  const statusOf = (status: string) =>
    contract([SERVES, PRESERVES, REQUIRES, LINK]).replace('status: active', `status: ${status}`)
  return {
    base: SEMCTX_BASE,
    branches: [
      { name: SEMCTX_CASES.partial.branch, from: 'main', commits: [fix] },
      {
        name: SEMCTX_CASES.verified.branch,
        from: 'main',
        commits: [fix, proven],
      },
      {
        name: SEMCTX_CASES.large.branch,
        from: 'main',
        commits: [
          {
            ...fix,
            files: {
              ...fix.files,
              [CONTRACT]: contract([SERVES, PRESERVES, REQUIRES, LINK]).replace(
                'statement: Harden add',
                `statement: Harden add${' so that a sum of finite numbers stays finite'.repeat(2000)}`,
              ),
            },
          },
          proven,
        ],
      },
      {
        name: SEMCTX_CASES.draft.branch,
        from: 'main',
        commits: [{ ...fix, files: { ...fix.files, [CONTRACT]: statusOf('draft') } }],
      },
      {
        name: SEMCTX_CASES.closed.branch,
        from: 'main',
        commits: [{ ...fix, files: { ...fix.files, [CONTRACT]: statusOf('verified') } }],
      },
      { name: SEMCTX_CASES.vacuous.branch, from: 'main', commits: [fixWith([SERVES, PRESERVES, LINK])] },
      {
        name: SEMCTX_CASES.mixed.branch,
        from: 'main',
        commits: [
          fixWith([SERVES, PRESERVES, REQUIRES, LINK], {
            '.semctx/semantic/changes/change.fx.note.sem': 'goal goal.fx.note\n  statement: not a change\n',
          }),
        ],
      },
      {
        name: SEMCTX_CASES.e2e.branch,
        from: 'main',
        commits: [fixWith([SERVES, PRESERVES, REQUIRES, LINK], { '.dev/stack.yml': STACK_E2E })],
      },
      { name: 'release', from: 'main', commits: [{ message: 'ci: e2e', files: { '.dev/stack.yml': STACK_E2E } }] },
      {
        name: SEMCTX_CASES.e2eDeleted.branch,
        from: 'release',
        commits: [fixWith([SERVES, PRESERVES, REQUIRES, LINK], { '.dev/stack.yml': STACK })],
      },
      {
        name: 'legacy',
        from: 'main',
        commits: [
          {
            message: 'feat: total add',
            files: {
              [OLD_CONTRACT]: old('Keep add total'),
              '.semctx/semantic/evidence-old.sem':
                'evidence proof.fx.old-test\n  statement: the add test runs\n  status: tested\n  link: test:src/a.test.ts\n',
            },
          },
        ],
      },
      {
        name: SEMCTX_CASES.modified.branch,
        from: 'legacy',
        commits: [
          {
            message: 'fix: finite add (#1)',
            files: { [OLD_CONTRACT]: old('Keep add total and finite'), 'src/a.ts': FINITE_ADD },
          },
        ],
      },
      {
        name: SEMCTX_CASES.amended.branch,
        from: 'legacy',
        commits: [
          fix,
          proven,
          { message: 'docs: old contract (#1)', files: { [OLD_CONTRACT]: old('Keep add total and finite') } },
        ],
      },
      {
        name: SEMCTX_CASES.mixedResults.branch,
        from: 'legacy',
        commits: [
          fix,
          { message: 'docs: old contract (#1)', files: { [OLD_CONTRACT]: old('Keep add total and finite') } },
        ],
      },
      {
        name: 'stray',
        from: 'main',
        commits: [
          {
            message: 'docs: x',
            files: { '.semctx/semantic/changes/x.sem': 'goal goal.fx.x\n  statement: not a change\n' },
          },
        ],
      },
      {
        name: SEMCTX_CASES.hidden.branch,
        from: 'stray',
        commits: [
          fix,
          proven,
          {
            message: 'feat: real (#1)',
            files: {
              '.semctx/semantic/other.sem':
                'change change.real\n  statement: The real change\n  status: active\n  provenance: author\n  serves: goal.fx.add\n  link: file:src/a.ts\n',
            },
          },
        ],
      },
      ...Object.values(SEMCTX_CASES)
        .filter((pr) => 'stack' in pr)
        .map((pr) => ({
          name: pr.branch,
          from: 'main',
          commits: [fixWith([SERVES, PRESERVES, REQUIRES, LINK], { '.dev/stack.yml': pr.stack })],
        })),
    ],
    issues: [{ number: 1, title: 'fix: finite add', issueType: 'fix' }],
    prs: Object.values(SEMCTX_CASES).map((pr) => ({
      number: pr.pr,
      branch: pr.branch,
      ...('base' in pr && { base: pr.base }),
      title: 'fix: finite add',
      body: 'Closes #1\n',
      closes: [1],
    })),
    ...overrides,
  }
}

/** The ignored-config repository's one PR: a VERIFIED change. */
export const IGNORED_CASE = { pr: 40, branch: 'fix/1-ignored' } as const

/**
 * Semctx configured by the operator's uncommitted `.semctx/config.json` in the
 * principal checkout, which `.gitignore` ignores; the contracts are committed.
 */
export function ignoredSpec(overrides: Partial<Spec> = {}): Spec {
  const { '.semctx/config.json': _config, ...committed } = SEMCTX_BASE
  return {
    base: { ...committed, '.gitignore': '.semctx/*\n!.semctx/semantic/\n' },
    principalFiles: { '.semctx/config.json': SEMCTX_CONFIG },
    branches: [
      {
        name: IGNORED_CASE.branch,
        from: 'main',
        commits: [fix, { message: 'test: add proven (#1)', files: { [EVIDENCE]: evidence('tested') } }],
      },
    ],
    issues: [{ number: 1, title: 'fix: finite add', issueType: 'fix' }],
    prs: [
      {
        number: IGNORED_CASE.pr,
        branch: IGNORED_CASE.branch,
        title: 'fix: finite add',
        body: 'Closes #1\n',
        closes: [1],
      },
    ],
    ...overrides,
  }
}

/** A repository with neither Semctx nor an assertledger adapter. */
export function plainSpec(overrides: Partial<Spec> = {}): Spec {
  return {
    base: { '.dev/stack.yml': STACK, 'src/a.ts': ADD },
    branches: [
      {
        name: 'fix/5-plain',
        from: 'main',
        commits: [{ message: 'fix: plain (#5)', files: { 'src/a.ts': FINITE_ADD } }],
      },
    ],
    issues: [{ number: 5, title: 'fix: plain', issueType: 'fix' }],
    prs: [{ number: 30, branch: 'fix/5-plain', title: 'fix: plain', body: 'Closes #5\n', closes: [5] }],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// assertledger: an adapter repository without Semctx, one PR per detection result
// ---------------------------------------------------------------------------

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
const clampFix = (test: keyof typeof LEDGER_TESTS): Commit => ({
  message: 'fix: clamp above range (#2)',
  files: { 'src/lib.js': CLAMP, [`test/${test}.test.js`]: LEDGER_TESTS[test] },
})
/** The comment-only revision of a fixed tree assertledger checks as neutral. */
const CLAMP_NEUTRAL: Commit = { message: 'chore: comment', files: { 'src/lib.js': `// clamp\n${CLAMP}` } }

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

// ---------------------------------------------------------------------------
// Both producers: Semctx configured and an assertledger adapter
// ---------------------------------------------------------------------------

/**
 * One fix PR both producers apply to: a VERIFIED change and a detection, posted
 * by one acquisition. assertledger checks worlds of one path set besides the
 * selected test, each an ancestor of the next, and the candidate adds a change
 * contract: its buggy world is the PR's first commit, `-buggy`, which opens and
 * proves the contract before the second fixes `clamp`.
 */
export const BOTH_CASE = { pr: 60, branch: 'fix/2-both', test: 'regression' } as const

export function bothSpec(overrides: Partial<Spec> = {}): Spec {
  const { pr, branch, test } = BOTH_CASE
  return {
    base: { ...SEMCTX_BASE, ...LEDGER_BASE },
    branches: [
      { name: `${branch}-buggy`, from: 'main', commits: [fix, proven] },
      { name: branch, from: `${branch}-buggy`, commits: [clampFix(test)] },
      { name: `${branch}-neutral`, from: branch, commits: [CLAMP_NEUTRAL] },
    ],
    issues: [{ number: 2, title: 'fix: clamp', issueType: 'fix' }],
    prs: [{ number: pr, branch, title: 'fix: clamp above range', body: 'Closes #2\n', closes: [2] }],
    ...overrides,
  }
}
