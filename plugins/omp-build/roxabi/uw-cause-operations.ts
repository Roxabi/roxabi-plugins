import type { IssueRef } from '../../issue-triage/skills/shared/domain/issue-write.ts'
import type { CauseSisterInput } from '../engine/cause-disposition-schema.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import type { UwCreateInput } from './uw-contract.ts'

function issueOf(scope: Scope): IssueRef {
  const prefix = `${scope.repository}#`
  const number = scope.target.startsWith(prefix) ? Number(scope.target.slice(prefix.length)) : NaN
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('cause-origin-not-issue')
  return { repository: scope.repository, number }
}

/** Frame only a previously authenticated final sister disposition; never copy original criterion IDs. */
export function frameSister(
  disposition: Extract<CanonicalRecord, { kind: 'cause-disposition' }>,
  input: CauseSisterInput,
  parent: Scope | null,
): UwCreateInput {
  const { subject, outcome, origin } = disposition.payload
  if (
    subject.kind !== 'cause' ||
    outcome.state !== 'final' ||
    (outcome.disposition !== 'sister-blocking' && outcome.disposition !== 'sister-after')
  )
    throw new Error('cause-not-sister')
  if (
    input.disposition.recordId !== disposition.recordId ||
    input.disposition.scope.repository !== disposition.repository ||
    input.disposition.scope.target !== disposition.target ||
    origin.uw.repository !== disposition.repository ||
    origin.uw.target !== disposition.target
  )
    throw new Error('cause-disposition-mismatch')
  if (parent !== null && parent.repository !== origin.uw.repository) throw new Error('cross-repository-parent')
  const cause = subject.cause
  const relation = outcome.disposition === 'sister-after' ? [issueOf(origin.uw)] : []
  return {
    repository: origin.uw.repository,
    title: cause.title,
    draft: {
      sections: {
        origin: `Original ${origin.uw.target}; decision ${subject.decision.recordId}; cause ${cause.id}; disposition ${disposition.recordId}.`,
        context: `${cause.mechanism}\n\n${cause.failure}`,
        change: `${cause.fix}\n\nPaths: ${cause.paths.join(', ')}`,
      },
      criteria: [{ kind: 'new', draftKey: 'restored', statement: `${cause.restored}\n\nProof: ${cause.proof}` }],
      invariants: [],
      exclusions: [],
      openQuestions: [],
    },
    factors: input.factors,
    tierOverride: input.tierOverride,
    normalization: [],
    writes: {
      labels: input.labels,
      relations: {
        parent: parent === null ? null : issueOf(parent),
        addChildren: [],
        removeChildren: [],
        addBlockers: relation,
        removeBlockers: [],
      },
    },
  }
}
