import {
  ADD,
  CONTRACT,
  contract,
  EVIDENCE,
  evidence,
  FINITE_ADD,
  LINK,
  PRESERVES,
  REQUIRES,
  SEMCTX_BASE,
  SEMCTX_CONFIG,
  SERVES,
  STACK,
  STACK_E2E,
} from './sandbox-semctx-base'
import type { Commit, Files, Spec } from './sandbox-types'

/**
 * PR number → the branch whose tip is the candidate. Native results cover
 * partial, verified, lifecycle, configuration, and historical-contract cases.
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
  largePartial: { pr: 36, branch: 'fix/1-large-partial' },
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

export const fixWith = (lines: string[], extra: Files = {}): Commit => ({
  message: 'fix: finite add (#1)',
  files: { [CONTRACT]: contract(lines), 'src/a.ts': FINITE_ADD, ...extra },
})
export const fix = fixWith([SERVES, PRESERVES, REQUIRES, LINK])
export const proven: Commit = { message: 'test: add proven (#1)', files: { [EVIDENCE]: evidence('tested') } }

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
        name: SEMCTX_CASES.largePartial.branch,
        from: SEMCTX_CASES.large.branch,
        commits: [{ message: 'test: evidence still pending (#1)', files: { [EVIDENCE]: evidence('declared') } }],
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
