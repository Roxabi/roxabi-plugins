import { SEMCTX_BASE } from './sandbox-semctx-base'
import type { Commit, Files } from './sandbox-types'

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
export const HISTORICAL = '.semctx/semantic/changes/change.fx.history.sem'
const EVIDENCE = '.semctx/semantic/evidence.sem'
const HISTORY_EVIDENCE = '.semctx/semantic/history-evidence.sem'
export const UNKNOWNS = '.semctx/semantic/unknowns.sem'

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
export function historical({
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

export const unknown = [
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

export const base = (old: string, extra: Files = {}): Files => ({
  ...SEMCTX_BASE,
  [HISTORICAL]: old,
  [HISTORY_EVIDENCE]: baseEvidence,
  ...extra,
})

export const candidate = (old: string, currentStatus = 'active', extra: Files = {}): Commit => ({
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

export const validBase = historical({ status: 'verified' })
export const validCandidate = historical({ status: 'superseded', links: ['src/a.test.ts', 'src/a.ts'] })
export const partialBase = historical({ status: 'partial', unknown: true })
export const partialCandidate = historical({
  status: 'superseded',
  unknown: true,
  links: ['src/a.test.ts', 'src/a.ts'],
})
export const blockedUnknown = [
  'unknown unknown.fx.old-review',
  '  statement: historic review blocks landing',
  '  status: declared',
  '  provenance: author',
  '  tag: critical',
  '',
].join('\n')
export const borrowedProvenanceBase = [
  historical({ status: 'verified', provenance: null }),
  'goal goal.fx.decoy',
  '  statement: Supplementary goal',
  '  provenance: author',
  '',
].join('\n')
export const borrowedProvenanceCandidate = borrowedProvenanceBase.replace('  status: verified', '  status: superseded')
export const duplicateLinkBase = historical({ status: 'verified', links: ['src/a.ts', 'src/a.ts', 'src/a.test.ts'] })
export const duplicateLinkCandidate = historical({
  status: 'superseded',
  links: ['src/a.ts', 'src/a.test.ts', 'src/a.test.ts'],
})
export const commentLinkBase = historical({ status: 'verified' }).replace(
  '  link: file:src/a.ts\n  link: file:src/a.test.ts',
  '  link: file:src/a.ts\n  # comments delimit a link run\n  link: file:src/a.test.ts',
)
export const crossCommentCandidate = commentLinkBase
  .replace('  status: verified', '  status: superseded')
  .replace(
    '  link: file:src/a.ts\n  # comments delimit a link run\n  link: file:src/a.test.ts',
    '  link: file:src/a.test.ts\n  # comments delimit a link run\n  link: file:src/a.ts',
  )
