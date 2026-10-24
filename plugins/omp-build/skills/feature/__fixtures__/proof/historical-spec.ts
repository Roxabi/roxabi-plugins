import {
  base,
  blockedUnknown,
  borrowedProvenanceBase,
  borrowedProvenanceCandidate,
  candidate,
  commentLinkBase,
  crossCommentCandidate,
  duplicateLinkBase,
  duplicateLinkCandidate,
  HISTORICAL,
  HISTORICAL_CASES,
  historical,
  partialBase,
  partialCandidate,
  UNKNOWNS,
  unknown,
  validBase,
  validCandidate,
} from './historical-cases'
import type { PrSpec, Spec } from './sandbox-types'

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
