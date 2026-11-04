import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { authenticatedReview } from '../../testing/cause-input-fixture.ts'
import { submission } from '../../testing/record-builders.ts'
import { acceptedPullRequestReviewGraph } from '../../testing/record-graphs.ts'
import { operation } from '../../testing/record-history.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { actionInputDigest, canonicalValueDigest } from '../action-input.ts'
import { assessAdjudicationSuccessor } from '../cause-adjudication-successor.ts'
import {
  assessCauseDispositions,
  effectiveRejectedFindingIds,
  resolveCauseActionInputs,
  validateCauseAdjudication,
  validateCauseDispositionRecords,
} from '../cause-disposition.ts'
import { causeAdjudicationProposalSchema } from '../cause-disposition-schema.ts'
import { buildRecord, parseRecord } from '../record-construction.ts'
import type { CanonicalRecord } from '../record-schema.ts'
import { resolveOwnSpecEffective } from '../spec-effective.ts'
import { resolveAcceptedSpec } from '../workflow-accepted-spec.ts'
import { recordsOf } from '../workflow-control.ts'
import { appendAccountedRecords, ref } from './cause-hold-fixture.ts'
import { assessFixture, mandateAssessmentState, proposedAssessmentState } from './workflow-spec-assessment-support.ts'
import { must } from './workflow-test-support.ts'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function lineageFixture(count: number, lastNonblocking: boolean) {
  const { graph, context } = authenticatedReview()
  const original = graph.panel.payload.findings?.[0]
  const final = graph.decision.payload.judgment.findings[0]
  const cause = graph.decision.payload.judgment.causes[0]
  if (!original || !final || !cause) throw new Error('Expected authenticated original and cause')
  const originals = Array.from({ length: count }, (_, index) => ({
    ...original,
    id: `${graph.panel.recordId}:f${index}`,
  }))
  const findings = originals.map((item, index) => ({
    ...final,
    id: `${final.id}-${index}`,
    label: lastNonblocking && index === count - 1 ? ('suggestion' as const) : final.label,
    sourceFindingIds: [item.id],
  }))
  const panelOutput = { findings: originals.map((item) => item.data) }
  const panel = must(
    parseRecord({
      ...graph.panel,
      payload: {
        ...graph.panel.payload,
        findings: originals,
        structured: panelOutput,
        rawAttempts: [
          submission({ id: `child-${graph.panel.recordId}`, structuredOutput: { status: 'valid', data: panelOutput } }),
        ],
      },
    }),
  )
  const judgment = {
    ...graph.decision.payload.judgment,
    findings,
    causes: [{ ...cause, findingIds: findings.map((item) => item.id) }],
  }
  const decision = must(parseRecord({ ...graph.decision, payload: { ...graph.decision.payload, judgment } }))
  const synthesis = must(
    parseRecord({
      ...graph.synthesisContribution,
      payload: {
        ...graph.synthesisContribution.payload,
        structured: judgment,
        rawAttempts: [
          submission({
            id: `child-${graph.synthesisContribution.recordId}`,
            structuredOutput: { status: 'valid', data: judgment },
          }),
        ],
      },
    }),
  )
  if (decision.kind !== 'decision') throw new Error('Expected decision')
  const source = {
    ...graph.history,
    operations: graph.history.operations.map((entry) => {
      if (entry.recordId === panel.recordId) return operation(panel)
      if (entry.recordId === decision.recordId) return operation(decision)
      if (entry.recordId === synthesis.recordId) return operation(synthesis)
      return entry
    }),
  }
  const fixtures = roxabiWorkflowFixtures()
  const mandate = fixtures.featureMandate(context.original, {
    recordId: 'mandate-42',
    body: 'Save the selected region',
  })
  let own = fixtures.historyFrom([mandate])
  const inputs = must(resolveCauseActionInputs({ decision, history: source, context }))
  const citation = inputs.flatMap((input) => input.manifest.repositoryReferences)[0]
  if (!citation) throw new Error('Expected pinned evidence')
  const assess = (adjudications: Extract<CanonicalRecord, { kind: 'cause-operation' }>[]) =>
    must(
      assessCauseDispositions({
        context,
        source: { kind: 'decision', decision },
        histories: [own, source],
        adjudications,
      }),
    ).outcomes.find((item) => item.subject.kind === 'cause')
  const initial = assess([])
  if (initial?.outcome.state !== 'pending-blocking') throw new Error('Expected pending cause')
  const disposition = (id: string, payload: typeof initial) => {
    const record = must(
      buildRecord({
        version: 1,
        ...context.original,
        recordId: id,
        runId: 'lineage-run',
        operationId: `write-${id}`,
        kind: 'cause-disposition',
        payload,
      }),
    )
    if (record.kind !== 'cause-disposition') throw new Error('Expected disposition')
    own = appendAccountedRecords(own, [record])
    return record
  }
  let pending = disposition('lineage-initial', initial)
  const transitions: {
    pending: typeof pending
    operation: Extract<CanonicalRecord, { kind: 'cause-operation' }>
    next: typeof pending
  }[] = []
  const rejected = lastNonblocking ? count - 1 : count
  for (let index = 0; index < rejected; index++) {
    const finding = findings[index]
    if (!finding) throw new Error('Expected distinct finding')
    const proposal = causeAdjudicationProposalSchema.parse({
      format: 'omp-build-cause-adjudication-proposal/1',
      operationId: `adjudicate-${index}`,
      operation: 'adjudicate-cause',
      uw: context.original,
      pending: ref(pending),
      pendingDigest: digest(pending),
      rejectedFindingIds: [finding.id],
      judgment: null,
      reason: 'Pinned evidence contradicts this finding',
      references: [citation],
    })
    const proposalDigest = digest(proposal)
    const intent = must(
      buildRecord({
        version: 1,
        ...context.original,
        recordId: `lineage-operation-${index}`,
        runId: 'lineage-run',
        operationId: `write-operation-${index}`,
        kind: 'cause-operation',
        payload: {
          format: 'omp-build-cause-operation/1',
          proposal,
          proposalDigest,
          confirmation: {
            route: 'omp-native-command',
            operationId: proposal.operationId,
            proposalDigest,
            confirmedAt: '2026-10-27T12:00:00.000Z',
          },
        },
      }),
    )
    if (intent.kind !== 'cause-operation') throw new Error('Expected operation')
    own = appendAccountedRecords(own, [intent])
    const nextPayload = assess([intent])
    if (!nextPayload || nextPayload.previous?.recordId !== pending.recordId) throw new Error('Expected exact successor')
    const next = disposition(`lineage-disposition-${index}`, nextPayload)
    transitions.push({ pending, operation: intent, next })
    pending = next
  }
  return { context, source, own, findings, transitions, pending, mandate, decision, inputs: graph.inputs }
}

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
    validateCauseDispositionRecords({ records: recordsOf(result.own), histories: [result.own, result.source] }),
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
      adjudications: [],
    }),
  )
  expect(observed.outcomes[0]?.outcome.state).toBe('pending-blocking')
  expect(fresh.decision.payload.judgment.findings[0]?.sourceFindingIds).toEqual(result.findings[0]?.sourceFindingIds)
  expect(must(effectiveRejectedFindingIds({ decision: fresh.decision, action, histories }))).toEqual([])
})
