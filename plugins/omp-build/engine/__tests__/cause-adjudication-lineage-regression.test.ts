import { expect, it } from 'vitest'
import { parseIssueSpecBody, rawSource } from '../../adapters/github-native/uw-spec.ts'
import { observeFixtureCatalogue } from '../../testing/action-input-fixtures.ts'
import { causeFixtureGraph } from '../../testing/cause-input-fixture.ts'
import { synthesisActionCapture } from '../../testing/criterion-dispositions.ts'
import { acceptedPullRequestReviewGraph } from '../../testing/record-graphs.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { actionInputDigest, canonicalValueDigest } from '../action-input.ts'
import { assessAdjudicationSuccessor, assessHistoricalAdjudicationSuccessor } from '../cause-adjudication-successor.ts'
import {
  assessCauseDispositions,
  validateCauseAdjudication,
  validateCauseDispositionRecords,
} from '../cause-disposition.ts'
import { historicalRejectedFindingIds } from '../cause-effective-findings.ts'
import { causeValidationFrame } from '../cause-validation-frame.ts'
import { resolveSpecEffective } from '../spec-effective.ts'
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
  const histories = [result.own, result.source]
  expect(
    validateCauseDispositionRecords({ records: recordsOf(result.own), histories, catalogues: result.catalogues }),
  ).toEqual([])
  expect(
    assessAdjudicationSuccessor({
      pending: last.pending,
      operation: last.operation,
      histories,
      catalogues: result.catalogues,
    }).ok,
  ).toBe(false)
  expect(
    must(
      assessHistoricalAdjudicationSuccessor(
        {
          pending: last.pending,
          operation: last.operation,
          context: result.context,
          histories,
          catalogues: result.catalogues,
        },
        causeValidationFrame(histories, result.catalogues),
      ),
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
      assessHistoricalAdjudicationSuccessor(
        {
          pending: last.pending,
          operation: last.operation,
          context: result.context,
          histories: [result.own, result.source],
          catalogues: result.catalogues,
        },
        causeValidationFrame([result.own, result.source], result.catalogues),
      ),
    ),
  ).toEqual(last.next.payload)
})

it('does not carry an authenticated rejection from accepted Spec A into a fresh review of B', () => {
  const result = lineageFixture(3, true)
  const accepted = mandateAssessmentState(result.mandate)
  const body = `${accepted.snapshot.raw.body}\n`
  const parsed = parseIssueSpecBody({
    uw: result.context.original,
    raw: rawSource(result.context.original.target, body, '2026-10-27T12:00:00.000Z'),
  })
  if (parsed.status !== 'conformant') throw new Error('Expected conformant editorial Spec B')
  const proposed = { ...proposedAssessmentState(accepted, { body }), snapshot: parsed.snapshot }
  const amendment = assessFixture(result.mandate, 'lineage-editorial', accepted, proposed, 'editorial', [
    result.own,
    result.source,
  ])
  const own = appendAccountedRecords(result.own, [amendment.start, amendment.result])
  const current = resolveAcceptedSpec(result.mandate, [own, result.source])
  if (!current.ok) throw new Error('Expected authenticated Spec B')
  const effective = must(
    resolveSpecEffective({
      mode: 'historical',
      own: current.spec.ref,
      versionVector: [current.spec.ref, ...current.spec.inheritedOwnSpecRefs],
      histories: [own, result.source],
    }),
  )
  const pr = { repository: result.context.original.repository, target: 'acme/app#45' }
  const binding = roxabiWorkflowFixtures().workflowBinding(pr, result.mandate, 'feat/fresh-b', 'main')
  const base = acceptedPullRequestReviewGraph({
    mandate: result.mandate,
    binding,
    prefix: 'admission-source',
    label: 'issue',
  })
  // The archived Spec B review cited the complete adjudicated Spec A lineage.
  const initial = result.transitions[0]?.pending
  if (!initial) throw new Error('Expected initial Spec A disposition')
  const lineage = [initial, ...result.transitions.flatMap(({ operation, next }) => [operation, next])]
  const pins = lineage.map((record) => ({
    source: 'record' as const,
    role: 'cause-state' as const,
    record: ref(record),
    selector: '/payload',
    digest: canonicalValueDigest(record.payload),
  }))
  const manifest = {
    ...base.inputs.manifest,
    spec: { kind: 'accepted' as const, effective },
    deliveryData: [...base.inputs.manifest.deliveryData, ...pins],
  }
  const action = { ...base.inputs, manifest, fingerprint: actionInputDigest(manifest) }
  const fresh = acceptedPullRequestReviewGraph({
    mandate: result.mandate,
    binding,
    prefix: 'admission-source',
    label: 'issue',
    inputs: action,
  })
  observeFixtureCatalogue(fresh.history)
  const histories = [own, result.source, fresh.history]
  const observed = must(
    assessCauseDispositions({
      context: { original: result.context.original, effective },
      capture: synthesisActionCapture(fresh.decision, [fresh.history]),
      graph: causeFixtureGraph(body),
      source: { kind: 'decision', decision: fresh.decision },
      histories,
      catalogues: result.catalogues,
      adjudications: [],
    }),
  )
  expect(observed.outcomes[0]?.outcome.state).toBe('pending-blocking')
  expect(fresh.decision.payload.judgment.findings[0]?.sourceFindingIds).toEqual(result.findings[0]?.sourceFindingIds)
  expect(
    must(historicalRejectedFindingIds({ decision: fresh.decision, action, histories, catalogues: result.catalogues })),
  ).toEqual([])
})
