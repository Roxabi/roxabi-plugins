import { expect, test } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { rawSource, renderIssueSpecBody } from '../../adapters/github-native/uw-spec.ts'
import { causeOriginalHistory, sisterRecords } from '../../testing/cause-input-fixture.ts'
import {
  causeFixtureMandate,
  causeFixtureScope,
  causeFixtureSnapshot,
} from '../../testing/cause-input-specification.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { canonicalValueDigest } from '../canonical-value.ts'
import { causeCreationProposalSchema } from '../cause-disposition-schema.ts'
import { buildRecord } from '../record-construction.ts'
import { specDigest } from '../record-digests.ts'
import { uwCreatePlanSchema } from '../uw-create-plan-schema.ts'
import { resolveAcceptedSpec } from '../workflow-accepted-spec.ts'
import { readComposedMaterialIntent } from '../workflow-composed-material-intent.ts'
import type { MaterialAuthorization } from '../workflow-mandate-schema.ts'
import { type MaterialAcceptanceProposal, materialAcceptanceDigest } from '../workflow-spec-assessment.ts'
import { assessFixture, mandateAssessmentState } from './workflow-spec-assessment-support.ts'
import { history, must } from './workflow-test-support.ts'

function composedHistory() {
  const sister = sisterRecords()
  const stored = sister.operation.payload.proposal
  if (stored.operation !== 'create' || stored.creation.kind !== 'sister') throw new Error('Expected a sister plan')
  const repository = causeFixtureScope.repository
  const parent = { repository, target: `${repository}#41` }
  const child = { repository, target: sister.identity.target }
  const parentIssue = { repository, number: 41 }
  const original = causeFixtureMandate()
  const existing = {
    scope: causeFixtureScope,
    snapshot: causeFixtureSnapshot,
    specVersion: causeFixtureSnapshot.spec.version,
    tier: original.payload.tier,
  }
  const mandate = roxabiWorkflowFixtures().epicMandate(parent, [existing])
  const mandateRef = { scope: parent, recordId: mandate.recordId, kind: 'mandate' as const }
  const predecessor = mandateRef
  const accepted = mandateAssessmentState(mandate)
  const observation = {
    state: 'active' as const,
    parent,
    historyDigest: 'a'.repeat(64),
    nativeDigest: 'b'.repeat(64),
    diagnostics: [],
  }
  const creation = { ...stored.creation, parent, parentObservation: observation }
  const { creation: _standaloneCreation, parentAcceptance: _standaloneConsent, ...standalone } = stored
  const plan = uwCreatePlanSchema.parse({
    ...standalone,
    renderedBody: renderIssueSpecBody(standalone.allocation.spec),
    writes: {
      labels: { add: ['size:S'], remove: [] },
      relations: { ...standalone.writes.relations, parent: parentIssue },
    },
  })
  const slot = { kind: 'created-by' as const, operationId: plan.operationId }
  const coverage = {
    parent: { uw: parent, version: accepted.ref.version },
    assignments: accepted.snapshot.spec.criteria.map(({ id: criterion }) => ({
      criterion,
      children: [existing.scope, slot] as [typeof existing.scope, typeof slot],
    })),
  }
  const { ref: _acceptedRef, ...state } = accepted
  const proposed = {
    ...state,
    children: [existing, { ...slot, plan, planDigest: canonicalValueDigest(plan) }],
    coverage,
  }
  const assessment = assessFixture(
    mandate,
    'composed-assessment',
    accepted,
    proposed,
    'material',
    [history([mandate], parent), causeOriginalHistory([sister.held]), sister.graph.history],
    undefined,
    undefined,
    undefined,
    { kind: 'cause-created-child', creation },
  )
  const proposal: MaterialAcceptanceProposal = {
    format: 'omp-build-material-acceptance/2',
    operationId: 'accept-composed-parent',
    uw: parent,
    mandate: mandateRef,
    predecessor,
    assessment: { scope: parent, recordId: assessment.result.recordId, kind: 'action-receipt' },
    classification: 'material',
    exactInputs: assessment.result.payload.exactInputs,
  }
  const parentProposalDigest = materialAcceptanceDigest(proposal)
  const outer = causeCreationProposalSchema.parse({
    ...plan,
    creation,
    parentAcceptance: {
      parent,
      mandate: mandateRef,
      predecessor,
      accepted: accepted.ref,
      versionVector: [accepted.ref, ...accepted.inheritedOwnSpecRefs],
      nativeObservationDigest: observation.nativeDigest,
      historyDigest: observation.historyDigest,
      assessment: proposal.assessment,
      exactInputs: proposal.exactInputs,
      slot,
      parentOperationId: proposal.operationId,
      parentProposalDigest,
    },
  })
  const proposalDigest = specDigest(JSON.stringify(outer))
  const confirmation = {
    route: 'omp-native-command' as const,
    operationId: plan.operationId,
    proposalDigest,
    confirmedAt: '2026-10-27T12:00:00Z',
  }
  const intentId = `${plan.operationId}:intent`
  const operation = must(
    buildRecord({
      ...existing.scope,
      version: 1,
      kind: 'cause-operation',
      recordId: intentId,
      runId: 'composed-run',
      operationId: intentId,
      payload: { format: 'omp-build-cause-operation/1', proposal: outer, proposalDigest, confirmation },
    }),
  )
  const identity = must(
    buildRecord({
      ...child,
      version: 1,
      kind: 'spec-identity',
      recordId: sister.identity.recordId,
      runId: 'composed-run',
      operationId: plan.operationId,
      payload: {
        format: 'omp-build-spec-identity/1',
        event: 'allocate',
        predecessor: null,
        proposalDigest,
        confirmation,
        allocations: plan.allocation.assignments,
      },
    }),
  )
  const snapshot = {
    spec: plan.allocation.spec,
    raw: rawSource(child.target, plan.renderedBody, confirmation.confirmedAt),
  }
  const authorization: Extract<MaterialAuthorization, { kind: 'cause-creation' }> = {
    kind: 'cause-creation',
    operation: { scope: existing.scope, kind: 'cause-operation', recordId: operation.recordId },
    binding: {
      slot,
      child,
      identity: { scope: child, kind: 'spec-identity', recordId: identity.recordId },
      snapshot,
      observed: {
        issue: { repository, number: 43 },
        title: plan.title,
        body: plan.renderedBody,
        updatedAt: confirmation.confirmedAt,
        nativeState: { state: 'OPEN', stateReason: null },
        labels: plan.writes.labels.add,
        parent: parentIssue,
        children: [],
        blockers: [],
      },
    },
    boundState: {
      ...state,
      children: [existing, { scope: child, snapshot, specVersion: snapshot.spec.version, tier: plan.tier }],
      coverage: {
        ...coverage,
        assignments: coverage.assignments.map(({ criterion }) => ({ criterion, children: [existing.scope, child] })),
      },
    },
  }
  const control = must(
    buildRecord({
      ...parent,
      version: 1,
      kind: 'operator-control',
      recordId: 'composed-material-control',
      runId: 'composed-run',
      operationId: proposal.operationId,
      payload: {
        control: 'accept-material',
        controlId: 'composed-material-control',
        mandate: mandateRef,
        predecessor,
        assessment: proposal.assessment,
        specVersion: accepted.ref.version,
        proposalDigest: parentProposalDigest,
        authorization,
        confirmation,
        identityDelta: { retired: proposal.exactInputs.mechanical.removed },
      },
    }),
  )
  const prefix = [
    history([mandate, assessment.start, assessment.result, control], parent),
    causeOriginalHistory([sister.held, operation]),
    sister.graph.history,
  ]
  return {
    mandate,
    control,
    accepted,
    input: { proposal, authorization, confirmation },
    prefix,
    identityHistory: history([identity], child),
  }
}

test('authenticates historical composed intent and substitutes the new child into accepted Parent coverage', () => {
  const { mandate, control, accepted, input, prefix, identityHistory } = composedHistory()
  const histories = [...prefix, identityHistory]
  expect(readComposedMaterialIntent({ ...input, histories })).toMatchObject({
    ok: true,
    value: { identity: { recordId: input.authorization.binding.identity.recordId } },
  })
  const material = resolveAcceptedSpec(mandate, histories)
  expect(material).toMatchObject({
    ok: true,
    spec: {
      ref: accepted.ref,
      children: input.authorization.boundState.children,
      coverage: input.authorization.boundState.coverage,
    },
  })
  if (!material.ok) throw new Error('Expected accepted Parent successor')
  expect(material.spec.chain.at(-1)).toMatchObject({
    kind: 'accept-material',
    source: { recordId: control.recordId, kind: 'operator-control' },
    assessment: input.proposal.assessment,
  })

  const missing = decodeHistory({ ...identityHistory.source, comments: [] })
  expect(readComposedMaterialIntent({ ...input, histories: [...prefix, missing] }).ok).toBe(false)
  expect(resolveAcceptedSpec(mandate, [...prefix, missing]).ok).toBe(false)

  const foreignCopies = identityHistory.source.comments.map((part, index) => ({
    ...part,
    locator: `foreign-${index}`,
    nativeId: `foreign-${index}`,
    author: 'intruder',
  }))
  const withForeign = decodeHistory({
    ...identityHistory.source,
    comments: [...identityHistory.source.comments, ...foreignCopies],
  })
  expect(withForeign.operations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'spec-identity', authority: 'foreign' }),
      expect.objectContaining({ kind: 'spec-identity', authority: 'accounted' }),
    ]),
  )
  expect(readComposedMaterialIntent({ ...input, histories: [...prefix, withForeign] }).ok).toBe(true)
  expect(resolveAcceptedSpec(mandate, [...prefix, withForeign])).toEqual(material)
})
