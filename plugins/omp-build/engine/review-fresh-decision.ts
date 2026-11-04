import { canonicalValueDigest } from './action-input.ts'
import {
  assessCauseDispositions,
  effectiveRejectedFindingIds,
  type Ref,
  validateCauseDispositionRecords,
} from './cause-disposition.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope, fail } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic } from './record-values.ts'
import type { DecisionAssessment, Result } from './result.ts'
import { assessDecision } from './review-decision.ts'
import { reviewInputsFromInventory } from './review-inventory-input.ts'
import { sameOwnSpecRef } from './spec-effective.ts'
import { bindExternalRef, recordsOf } from './workflow-control.ts'

type Decision = Extract<CanonicalRecord, { kind: 'decision' }>
type Disposition = Extract<CanonicalRecord, { kind: 'cause-disposition' }>
type AcceptedSpec = Extract<
  NonNullable<ReturnType<typeof reviewInputsFromInventory>>['manifest']['spec'],
  { kind: 'accepted' }
>

function reviewSourceDiagnostic(subject: Disposition['payload']['subject'], decision: Decision): Diagnostic | null {
  if (
    subject.kind === 'cause' &&
    (subject.decision.recordId !== decision.recordId || !equalScope(subject.decision.scope, decision))
  )
    return diagnostic('cause-source-mismatch', 'Review disposition belongs to another decision')
  if (
    subject.kind === 'retained-finding' &&
    (!equalScope(subject.contribution.scope, decision) ||
      !decision.payload.judgment.sourceContributionIds.includes(subject.contribution.recordId))
  )
    return diagnostic('cause-source-mismatch', 'Retained finding belongs to another decision source')
  if (
    subject.kind === 'rule-error' &&
    (!equalScope(subject.source.scope, decision) || subject.source.recordId !== decision.recordId)
  )
    return diagnostic('cause-source-mismatch', 'Rule error belongs to another decision')
  return null
}

function bindReviewDispositions(
  refs: readonly Ref<'cause-disposition'>[],
  origin: DecodedHistory,
  spec: AcceptedSpec,
  decision: Decision,
): Result<Disposition[]> {
  if (new Set(refs.map((ref) => JSON.stringify(ref))).size !== refs.length)
    return fail([diagnostic('duplicate-reference', 'Review repeats a disposition reference')])
  const relevant: Disposition[] = []
  for (const ref of refs) {
    if (!equalScope(ref.scope, spec.effective.own.uw))
      return fail([diagnostic('cause-origin-mismatch', 'Review disposition belongs to another UW')])
    const source = bindExternalRef(ref, origin)
    if (!source.ok) return source
    if (source.value.kind !== 'cause-disposition')
      return fail([diagnostic('kind-mismatch', 'Review disposition has the wrong kind')])
    const disposition = source.value
    if (!sameOwnSpecRef(disposition.payload.origin, spec.effective.own))
      return fail([diagnostic('cause-origin-mismatch', 'Review disposition belongs to another accepted Spec')])
    const issue = reviewSourceDiagnostic(disposition.payload.subject, decision)
    if (issue !== null) return fail([issue])
    relevant.push(disposition)
  }
  return { ok: true, value: relevant }
}

function validateBoundAssessment(
  record: Decision,
  spec: AcceptedSpec,
  refs: readonly Ref<'cause-disposition'>[],
  histories: readonly DecodedHistory[],
  assessment: DecisionAssessment,
): Result<DecisionAssessment> {
  const uw = spec.effective.own.uw
  const origin = histories.find((entry) => equalScope(entry.source.scope, uw))
  if (!origin) return fail([diagnostic('missing-history', 'Fresh review requires the original UW disposition history')])
  const bound = bindReviewDispositions(refs, origin, spec, record)
  if (!bound.ok) return bound
  const relevant = bound.value
  const validation = validateCauseDispositionRecords({ records: recordsOf(origin), histories })
  if (validation.length) return fail(validation)
  const expected = assessCauseDispositions({
    context: { original: uw, effective: spec.effective },
    source: { kind: 'decision', decision: record },
    histories,
    adjudications: [],
  })
  if (!expected.ok) return expected
  const expectedPayloads = expected.value.outcomes.map(canonicalValueDigest).sort()
  const observedPayloads = relevant.map((entry) => canonicalValueDigest(entry.payload)).sort()
  if (canonicalValueDigest(expectedPayloads) !== canonicalValueDigest(observedPayloads))
    return fail([diagnostic('cause-disposition-incomplete', 'Review must bind the exact complete initial assessment')])
  if (
    record.payload.judgment.causes.some(
      (cause) =>
        !relevant.some(
          (entry) => entry.payload.subject.kind === 'cause' && entry.payload.subject.cause.id === cause.id,
        ),
    )
  )
    return fail([diagnostic('cause-disposition-incomplete', 'The fresh review lacks a disposition for every cause')])
  const veto = relevant.some(
    (entry) =>
      entry.payload.outcome.state === 'pending-blocking' ||
      (entry.payload.outcome.state === 'final' &&
        (entry.payload.outcome.disposition === 'fix-original' ||
          entry.payload.outcome.disposition === 'sister-blocking')),
  )
  return { ok: true, value: veto ? { ...assessment, verdict: 'Request changes' } : assessment }
}

export function validateFreshDecision(
  record: Extract<CanonicalRecord, { kind: 'decision' }>,
  history: DecodedHistory,
  taxonomy: readonly string[],
  acceptedPolicyRef: string | null,
  externalHistories: readonly DecodedHistory[] = [],
  deliveryHistory: DecodedHistory = history,
  reviewDispositionRefs?: readonly Ref<'cause-disposition'>[],
): Result<DecisionAssessment> {
  if (reviewDispositionRefs === undefined)
    return fail([
      diagnostic('cause-disposition-incomplete', 'Live review must bind its complete disposition assessment'),
    ])
  if (record.payload.judgment.purpose !== 'review')
    return fail([diagnostic('cause-context-unbound', 'Effective finding veto requires a review decision')])
  const inputs = reviewInputsFromInventory(record.payload.judgment, history)
  if (inputs === null) return fail([diagnostic('cause-context-unbound', 'Review has no authenticated input snapshot')])
  const selected = inputs.manifest.deliveryData.filter((item) => item.role === 'cause-state')
  let rejected: readonly string[] = []
  const histories = [deliveryHistory, ...externalHistories]
  if (selected.some((item) => item.record.kind === 'cause-disposition')) {
    const effective = effectiveRejectedFindingIds({ decision: record, action: inputs, histories })
    if (!effective.ok) return effective
    rejected = effective.value
  }
  const assessment = assessDecision(
    record,
    history,
    taxonomy,
    acceptedPolicyRef,
    externalHistories,
    deliveryHistory,
    new Set(rejected),
  )
  if (!assessment.admissible) return { ok: true, value: assessment }
  if (inputs.manifest.spec.kind !== 'accepted')
    return reviewDispositionRefs.length === 0
      ? { ok: true, value: assessment }
      : fail([diagnostic('cause-origin-mismatch', 'Standalone review cannot select UW dispositions')])
  return validateBoundAssessment(record, inputs.manifest.spec, reviewDispositionRefs, histories, assessment)
}
