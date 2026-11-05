import { expect, it } from 'vitest'
import { acceptedPullRequestReviewGraph } from '../../testing/record-graphs.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { actionInputDigest, canonicalValueDigest } from '../action-input.ts'
import { assessAdjudicationSuccessor } from '../cause-adjudication-successor.ts'
import {
  assessCauseDispositions,
  effectiveRejectedFindingIds,
  validateCauseAdjudication,
  validateCauseDispositionRecords,
} from '../cause-disposition.ts'
import { resolveOwnSpecEffective } from '../spec-effective.ts'
import { resolveAcceptedSpec } from '../workflow-accepted-spec.ts'
import { recordsOf } from '../workflow-control.ts'
import { appendAccountedRecords, ref } from './cause-hold-fixture.ts'
import { lineageFixture } from './cause-lineage-fixture.ts'
import { assessFixture, mandateAssessmentState, proposedAssessmentState } from './workflow-spec-assessment-support.ts'
import { must } from './workflow-test-support.ts'

it('retains two distinct rejections across authenticated successors without resurrecting the first', () => {
  const result = lineageFixture(3, true)
  expect(result.transitions[0]?.next.payload.outcome.state).toBe('pending-blocking')
  expect(
    result.transitions.map(
      (entry) =>
        entry.operation.payload.proposal.operation === 'adjudicate-cause' &&
        entry.operation.payload.proposal.rejectedFindingIds,
    ),
  ).toEqual([[result.findings[0]?.id], [result.findings[1]?.id]])
  expect(result.pending.payload.outcome).toMatchObject({ state: 'final', disposition: 'report', blocking: false })
  const last = result.transitions[1]
  if (!last) throw new Error('Expected second operation')
  expect(
    must(
      assessAdjudicationSuccessor({
        pending: last.pending,
        operation: last.operation,
        context: result.context,
        histories: [result.own, result.source],
        catalogues: result.catalogues,
      }),
    ),
  ).toEqual(last.next.payload)
})

it('validates a long authenticated lineage and its final disposition without losing any rejection', () => {
  const result = lineageFixture(10, false)
  expect(result.transitions).toHaveLength(10)
  expect(
    result.transitions.slice(0, -1).every((entry) => entry.next.payload.outcome.state === 'pending-blocking'),
  ).toBe(true)
  expect(result.pending.payload.outcome).toMatchObject({ state: 'final', disposition: 'report', blocking: false })
  expect(
    validateCauseDispositionRecords({
      records: recordsOf(result.own),
      histories: [result.own, result.source],
      catalogues: result.catalogues,
    }),
  ).toEqual([])
  const last = result.transitions[9]
  if (!last) throw new Error('Expected final operation')
  const proposal = last.operation.payload.proposal
  if (proposal.operation !== 'adjudicate-cause') throw new Error('Expected adjudication proposal')
  const competing = { ...proposal, operationId: 'competing-intent' }
  expect(
    validateCauseAdjudication({
      proposal: competing,
      pending: last.pending,
      context: result.context,
      histories: [result.own, result.source],
    }).map((item) => item.code),
  ).toContain('cause-adjudication-ambiguous')
  expect(
    must(
      assessAdjudicationSuccessor({
        pending: last.pending,
        operation: last.operation,
        context: result.context,
        histories: [result.own, result.source],
        catalogues: result.catalogues,
      }),
    ),
  ).toEqual(last.next.payload)
})

it('does not carry an authenticated rejection from accepted Spec A into a fresh review of B', () => {
  const result = lineageFixture(3, true)
  const accepted = mandateAssessmentState(result.mandate)
  const proposed = proposedAssessmentState(accepted, { body: 'Editorial clarification of selected region' })
  const amendment = assessFixture(result.mandate, 'lineage-editorial', accepted, proposed, 'editorial')
  const own = appendAccountedRecords(result.own, [amendment.start, amendment.result])
  const current = resolveAcceptedSpec(result.mandate, [own, result.source])
  if (!current.ok) throw new Error('Expected authenticated Spec B')
  const effective = must(resolveOwnSpecEffective(current.spec))
  const pr = { repository: result.context.original.repository, target: 'acme/app#45' }
  const binding = roxabiWorkflowFixtures().workflowBinding(pr, result.mandate, 'feat/fresh-b', 'main')
  const base = acceptedPullRequestReviewGraph({
    mandate: result.mandate,
    binding,
    prefix: 'admission-source',
    label: 'issue',
  })
  const pin = {
    source: 'record' as const,
    record: ref(result.pending),
    selector: '/payload',
    role: 'cause-state' as const,
    digest: canonicalValueDigest(result.pending.payload),
  }
  const manifest = {
    ...base.inputs.manifest,
    spec: { kind: 'accepted' as const, effective },
    deliveryData: [...base.inputs.manifest.deliveryData, pin],
  }
  const action = { ...base.inputs, manifest, fingerprint: actionInputDigest(manifest) }
  const fresh = acceptedPullRequestReviewGraph({
    mandate: result.mandate,
    binding,
    prefix: 'admission-source',
    label: 'issue',
    inputs: action,
  })
  const histories = [own, result.source, fresh.history]
  const observed = must(
    assessCauseDispositions({
      context: { original: result.context.original, effective },
      source: { kind: 'decision', decision: fresh.decision },
      histories,
      catalogues: result.catalogues,
      adjudications: [],
    }),
  )
  expect(observed.outcomes[0]?.outcome.state).toBe('pending-blocking')
  expect(fresh.decision.payload.judgment.findings[0]?.sourceFindingIds).toEqual(result.findings[0]?.sourceFindingIds)
  expect(
    must(effectiveRejectedFindingIds({ decision: fresh.decision, action, histories, catalogues: result.catalogues })),
  ).toEqual([])
})
