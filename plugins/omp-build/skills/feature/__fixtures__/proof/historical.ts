import type { Commit, Files, PrSpec, Spec } from './sandbox'
import { SEMCTX_BASE } from './sandbox'

export const HISTORICAL_CASES = {
  // Keep original fixture PR #813 (proof packets bind it). Distinct Spec issue #812 — not same-scope.
  valid: { pr: 813, branch: 'fix/813-valid', base: 'main' },
  partial: { pr: 814, branch: 'fix/813-partial', base: 'history-partial-base' },
  blocked: { pr: 815, branch: 'fix/813-blocked', base: 'history-blocked-base' },
  ownSuperseded: { pr: 816, branch: 'fix/813-own-superseded', base: 'main' },
  statementChanged: { pr: 817, branch: 'fix/813-statement-changed', base: 'main' },
  linkRemoved: { pr: 818, branch: 'fix/813-link-removed', base: 'main' },
  provenanceChanged: { pr: 819, branch: 'fix/813-provenance-changed', base: 'main' },
  missingBaseProvenance: {
    pr: 820,
    branch: 'fix/813-missing-base-provenance',
    base: 'history-missing-provenance-base',
  },
  duplicateBaseStatus: { pr: 821, branch: 'fix/813-duplicate-base-status', base: 'history-duplicate-status-base' },
  duplicateBaseProvenance: {
    pr: 822,
    branch: 'fix/813-duplicate-base-provenance',
    base: 'history-duplicate-provenance-base',
  },
  linkReplaced: { pr: 823, branch: 'fix/813-link-replaced', base: 'main' },
  linkDuplicated: { pr: 824, branch: 'fix/813-link-duplicated', base: 'history-duplicate-links-base' },
  linkCrossedComment: { pr: 825, branch: 'fix/813-link-crossed-comment', base: 'history-comment-links-base' },
  invalidBaseProvenance: {
    pr: 826,
    branch: 'fix/813-invalid-base-provenance',
    base: 'history-invalid-provenance-base',
  },
  borrowedProvenance: {
    pr: 827,
    branch: 'fix/813-borrowed-provenance',
    base: 'history-borrowed-provenance-base',
  },
} as const

export type HistoricalCase = keyof typeof HISTORICAL_CASES

const CURRENT = '.semctx/semantic/changes/change.fx.current.sem'
const HISTORICAL = '.semctx/semantic/changes/change.fx.history.sem'
const EVIDENCE = '.semctx/semantic/evidence.sem'
const HISTORY_EVIDENCE = '.semctx/semantic/history-evidence.sem'
const UNKNOWNS = '.semctx/semantic/unknowns.sem'

const current = (status = 'active') =>
  [
    'change change.fx.current',
    '  statement: Reject non-finite addends',
    `  status: ${status}`,
    '  provenance: author',
    '  serves: goal.fx.add',
    '  preserves: invariant.fx.add-sum',
    '  requires_evidence: proof.fx.current-test',
    '  link: file:src/a.ts',
    '',
  ].join('\n')

type HistoricalOptions = {
  status: 'active' | 'partial' | 'verified' | 'superseded'
  statement?: string
  provenance?: string | null
  duplicateStatus?: boolean
  duplicateProvenance?: boolean
  unknown?: boolean
  links?: string[]
}

/** The raw source form whose only allowed candidate-side changes are status and a flat file-link run permutation. */
function historical({
  status,
  statement = 'Keep finite addition total',
  provenance = 'author',
  duplicateStatus = false,
  duplicateProvenance = false,
  unknown = false,
  links = ['src/a.ts', 'src/a.test.ts'],
}: HistoricalOptions): string {
  return [
    'change change.fx.history',
    `  statement: ${statement}`,
    `  status: ${status}`,
    ...(duplicateStatus ? [`  status : ${status}`] : []),
    ...(provenance ? [`  provenance: ${provenance}`] : []),
    ...(duplicateProvenance ? [`  provenance : ${provenance}`] : []),
    '  serves: goal.fx.add',
    '  preserves: invariant.fx.add-sum',
    '  requires_evidence: proof.fx.history-test',
    ...(unknown ? ['  unknown: unknown.fx.old-review'] : []),
    ...links.map((link) => `  link: file:${link}`),
    '',
  ].join('\n')
}

const baseEvidence = [
  'evidence proof.fx.history-test',
  '  statement: the historic finite-add test ran',
  '  status: tested',
  '  link: test:src/a.test.ts',
  '',
].join('\n')

const currentEvidence = (status: 'declared' | 'tested') =>
  [
    'evidence proof.fx.current-test',
    '  statement: the finite-add rejection test runs',
    `  status: ${status}`,
    '  link: test:src/a.test.ts',
    '',
  ].join('\n')

const unknown = [
  'unknown unknown.fx.old-review',
  '  statement: historic review has not completed',
  '  status: declared',
  '  provenance: author',
  '',
].join('\n')

const FINITE_ADD =
  "export function add(a: number, b: number): number {\n  if (!Number.isFinite(a) || !Number.isFinite(b)) throw new RangeError('finite only')\n  return a + b\n}\n"
const FINITE_TEST =
  "import { expect, test } from 'bun:test'\nimport { add } from './a'\ntest('finite addition', () => expect(() => add(1, Infinity)).toThrow(RangeError))\n"

const base = (old: string, extra: Files = {}): Files => ({
  ...SEMCTX_BASE,
  [HISTORICAL]: old,
  [HISTORY_EVIDENCE]: baseEvidence,
  ...extra,
})

const candidate = (old: string, currentStatus = 'active', extra: Files = {}): Commit => ({
  message: 'fix: retain historical admission (#813)',
  files: {
    [CURRENT]: current(currentStatus),
    [HISTORICAL]: old,
    [EVIDENCE]: currentEvidence('tested'),
    'src/a.ts': FINITE_ADD,
    'src/a.test.ts': FINITE_TEST,
    ...extra,
  },
})

const validBase = historical({ status: 'verified' })
const validCandidate = historical({ status: 'superseded', links: ['src/a.test.ts', 'src/a.ts'] })
const partialBase = historical({ status: 'partial', unknown: true })
const partialCandidate = historical({ status: 'superseded', unknown: true, links: ['src/a.test.ts', 'src/a.ts'] })
const blockedUnknown = [
  'unknown unknown.fx.old-review',
  '  statement: historic review blocks landing',
  '  status: declared',
  '  provenance: author',
  '  tag: critical',
  '',
].join('\n')
const borrowedProvenanceBase = [
  historical({ status: 'verified', provenance: null }),
  'goal goal.fx.decoy',
  '  statement: Supplementary goal',
  '  provenance: author',
  '',
].join('\n')
const borrowedProvenanceCandidate = borrowedProvenanceBase.replace('  status: verified', '  status: superseded')
const duplicateLinkBase = historical({ status: 'verified', links: ['src/a.ts', 'src/a.ts', 'src/a.test.ts'] })
const duplicateLinkCandidate = historical({
  status: 'superseded',
  links: ['src/a.ts', 'src/a.test.ts', 'src/a.test.ts'],
})
const commentLinkBase = historical({ status: 'verified' }).replace(
  '  link: file:src/a.ts\n  link: file:src/a.test.ts',
  '  link: file:src/a.ts\n  # comments delimit a link run\n  link: file:src/a.test.ts',
)
const crossCommentCandidate = commentLinkBase
  .replace('  status: verified', '  status: superseded')
  .replace(
    '  link: file:src/a.ts\n  # comments delimit a link run\n  link: file:src/a.test.ts',
    '  link: file:src/a.test.ts\n  # comments delimit a link run\n  link: file:src/a.ts',
  )

/**
 * Isolated native-capture scenarios for retained historical contracts. Existing
 * `semctxSpec` branches and their SHA-bound capture stay untouched.
 */
export function historicalSpec(): Spec {
  const branches = [
    {
      name: 'history-partial-base',
      from: 'main',
      commits: [
        { message: 'feat: record historic unknown', files: { [HISTORICAL]: partialBase, [UNKNOWNS]: unknown } },
      ],
    },
    {
      name: 'history-blocked-base',
      from: 'main',
      commits: [
        {
          message: 'feat: record critical historic unknown',
          files: { [HISTORICAL]: partialBase, [UNKNOWNS]: blockedUnknown },
        },
      ],
    },
    {
      name: 'history-missing-provenance-base',
      from: 'main',
      commits: [
        {
          message: 'feat: historic contract lacks provenance',
          files: { [HISTORICAL]: historical({ status: 'verified', provenance: null }) },
        },
      ],
    },
    {
      name: 'history-invalid-provenance-base',
      from: 'main',
      commits: [
        {
          message: 'feat: historic contract has unsupported provenance',
          files: { [HISTORICAL]: historical({ status: 'verified', provenance: 'operator' }) },
        },
      ],
    },
    {
      name: 'history-duplicate-status-base',
      from: 'main',
      commits: [
        {
          message: 'feat: ambiguous historic lifecycle',
          files: { [HISTORICAL]: historical({ status: 'verified', duplicateStatus: true }) },
        },
      ],
    },
    {
      name: 'history-duplicate-provenance-base',
      from: 'main',
      commits: [
        {
          message: 'feat: ambiguous historic provenance',
          files: { [HISTORICAL]: historical({ status: 'verified', duplicateProvenance: true }) },
        },
      ],
    },
    {
      name: 'history-duplicate-links-base',
      from: 'main',
      commits: [{ message: 'feat: retain duplicate historic links', files: { [HISTORICAL]: duplicateLinkBase } }],
    },
    {
      name: 'history-comment-links-base',
      from: 'main',
      commits: [{ message: 'feat: retain commented historic links', files: { [HISTORICAL]: commentLinkBase } }],
    },
    { name: HISTORICAL_CASES.valid.branch, from: 'main', commits: [candidate(validCandidate)] },
    { name: HISTORICAL_CASES.partial.branch, from: 'history-partial-base', commits: [candidate(partialCandidate)] },
    { name: HISTORICAL_CASES.blocked.branch, from: 'history-blocked-base', commits: [candidate(partialCandidate)] },
    { name: HISTORICAL_CASES.ownSuperseded.branch, from: 'main', commits: [candidate(validCandidate, 'superseded')] },
    {
      name: HISTORICAL_CASES.statementChanged.branch,
      from: 'main',
      commits: [
        candidate(
          historical({
            status: 'superseded',
            statement: 'Change the historic obligation',
            links: ['src/a.test.ts', 'src/a.ts'],
          }),
        ),
      ],
    },
    {
      name: HISTORICAL_CASES.linkRemoved.branch,
      from: 'main',
      commits: [candidate(historical({ status: 'superseded', links: ['src/a.test.ts'] }))],
    },
    {
      name: HISTORICAL_CASES.provenanceChanged.branch,
      from: 'main',
      commits: [
        candidate(historical({ status: 'superseded', provenance: 'agent', links: ['src/a.test.ts', 'src/a.ts'] })),
      ],
    },
    {
      name: HISTORICAL_CASES.missingBaseProvenance.branch,
      from: 'history-missing-provenance-base',
      commits: [
        candidate(historical({ status: 'superseded', provenance: null, links: ['src/a.test.ts', 'src/a.ts'] })),
      ],
    },
    {
      name: HISTORICAL_CASES.invalidBaseProvenance.branch,
      from: 'history-invalid-provenance-base',
      commits: [
        candidate(historical({ status: 'superseded', provenance: 'operator', links: ['src/a.test.ts', 'src/a.ts'] })),
      ],
    },
    {
      name: HISTORICAL_CASES.duplicateBaseStatus.branch,
      from: 'history-duplicate-status-base',
      commits: [
        candidate(historical({ status: 'superseded', duplicateStatus: true, links: ['src/a.test.ts', 'src/a.ts'] })),
      ],
    },
    {
      name: HISTORICAL_CASES.duplicateBaseProvenance.branch,
      from: 'history-duplicate-provenance-base',
      commits: [
        candidate(
          historical({ status: 'superseded', duplicateProvenance: true, links: ['src/a.test.ts', 'src/a.ts'] }),
        ),
      ],
    },
    {
      name: HISTORICAL_CASES.linkReplaced.branch,
      from: 'main',
      commits: [candidate(historical({ status: 'superseded', links: ['src/a.test.ts', 'src/b.ts'] }))],
    },
    {
      name: HISTORICAL_CASES.linkDuplicated.branch,
      from: 'history-duplicate-links-base',
      commits: [candidate(duplicateLinkCandidate)],
    },
    {
      name: HISTORICAL_CASES.linkCrossedComment.branch,
      from: 'history-comment-links-base',
      commits: [candidate(crossCommentCandidate)],
    },
    {
      name: HISTORICAL_CASES.borrowedProvenance.base,
      from: 'main',
      commits: [{ message: 'feat: retain mixed historical source', files: { [HISTORICAL]: borrowedProvenanceBase } }],
    },
    {
      name: HISTORICAL_CASES.borrowedProvenance.branch,
      from: HISTORICAL_CASES.borrowedProvenance.base,
      commits: [candidate(borrowedProvenanceCandidate)],
    },
  ]
  const prs: PrSpec[] = Object.values(HISTORICAL_CASES).map(({ pr, branch, base }) => ({
    number: pr,
    branch,
    base,
    title: 'fix: retain historical admission',
    body: 'Closes #812\n',
    closes: [812],
  }))
  return {
    base: base(validBase),
    branches,
    issues: [{ number: 812, title: 'retain historical admission', issueType: 'fix' }],
    prs,
  }
}
