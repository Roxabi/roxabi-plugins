import { describe, expect, test } from 'vitest'
import { parseIssueSpecBody, rawSource } from '../../adapters/github-native/uw-spec.ts'
import { strictSpecBody } from '../../skills/feature/testing/epic-driver/epic-driver-records.ts'
import { observeFixtureNativeWorld } from '../../testing/action-input-fixtures.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { actionInputDigest, canonicalActionOperands } from '../action-input.ts'
import { actionInputManifestSchema } from '../action-input-schema.ts'
import type { DecodedHistory } from '../history-schema.ts'
import { parseRecord } from '../record-construction.ts'
import { failedCheckEvidenceDigest } from '../record-digests.ts'
import { actionRequestSchema } from '../uw-action-command-schema.ts'
import { prepareMaterialAcceptance } from '../workflow-material-acceptance.ts'
import { actionReceiptPayloadSchema } from '../workflow-receipt-schema.ts'
import { reconstructWorkflow } from '../workflow-reconstruction-admission.ts'
import {
  type AssessmentState,
  acceptedMaterialState,
  acceptMaterialFixture,
  assessFixture,
  currentFacts,
  decisions,
  mandateAssessmentState,
  proposedAssessmentState,
  shippedFeatureMandate,
} from './workflow-spec-assessment-support.ts'
import { history, must, PARENT, SCOPE } from './workflow-test-support.ts'

const nativeInitialBody = strictSpecBody('ship the bounded workflow')
function parsedNativeSpec(body: string) {
  const parsed = parseIssueSpecBody({ uw: SCOPE, raw: rawSource(SCOPE.target, body, '2026-10-21T00:00:00Z') })
  if (parsed.status !== 'conformant') throw new Error('Expected a conformant declared Spec')
  return parsed.snapshot
}
function nativeMandate() {
  const mandate = shippedFeatureMandate()
  const record = must(
    parseRecord({
      ...mandate,
      payload: {
        ...mandate.payload,
        ownSpec: roxabiWorkflowFixtures().ownSpecFromSnapshot(SCOPE, parsedNativeSpec(nativeInitialBody)),
      },
    }),
  )
  if (record.kind !== 'mandate') throw new Error('Expected a native mandate')
  return record
}
function nativeProposal(accepted: AssessmentState, body: string) {
  const spec = parsedNativeSpec(body).spec
  return proposedAssessmentState(accepted, {
    body,
    content: {
      criteria: spec.criteria,
      invariants: spec.invariants,
      exclusions: spec.exclusions,
      openQuestions: spec.openQuestions,
      sections: spec.sections,
    },
  })
}

async function nativeEvidence(issue: DecodedHistory, body: string, updatedAt: string) {
  const causal = await observeFixtureNativeWorld({
    root: SCOPE,
    nodes: [
      {
        scope: SCOPE,
        title: 'Bounded workflow',
        body,
        updatedAt,
        labels: ['size:S'],
        parent: null,
        children: [],
        blockers: [],
        state: 'OPEN',
        stateReason: null,
      },
    ],
    histories: [issue],
    pullRequests: [],
    commits: [],
    comparisons: [],
  })
  return { issue, pullRequest: null, parents: [], causal }
}

describe('workflow Spec assessment operand binding and freshness', () => {
  test('seals exact assessment operands and ignores only observed timestamps in fingerprints', () => {
    const fixture = roxabiWorkflowFixtures()
    const child = fixture.childSnapshot(PARENT, 'A real child commitment')
    const mandated = fixture.epicMandate(SCOPE, [child])
    const accepted = mandateAssessmentState(mandated)
    const state = accepted
    const assessment = assessFixture(
      mandated,
      'operand-binding',
      state,
      proposedAssessmentState(state, { body: 'new proposal' }),
      'material',
      [history([mandated]), history([], PARENT)],
    )
    if (assessment.start.kind !== 'action-receipt' || assessment.start.payload.action !== 'assess-spec')
      throw new Error('expected assessment')
    const payload = assessment.start.payload
    const operands = payload.inputs.manifest.operands
    if (operands?.action !== 'assess-spec') throw new Error('expected operands')
    const updated = (snapshot: typeof accepted.snapshot) => ({
      ...snapshot,
      raw: { ...snapshot.raw, lastEditedAt: null },
    })
    const revisedState = <T extends typeof operands.exactInputs.proposed>(value: T) => ({
      ...value,
      snapshot: updated(value.snapshot),
      children: value.children.map((item) =>
        'snapshot' in item ? { ...item, snapshot: updated(item.snapshot) } : item,
      ),
    })
    const timed = {
      ...operands,
      exactInputs: {
        ...operands.exactInputs,
        accepted: revisedState(operands.exactInputs.accepted),
        proposed: revisedState(operands.exactInputs.proposed),
      },
    }
    expect(canonicalActionOperands(timed)).toBe(canonicalActionOperands(operands))
    expect(actionInputDigest({ ...payload.inputs.manifest, operands: timed })).toBe(payload.inputs.fingerprint)
    const changed = {
      ...timed,
      exactInputs: {
        ...timed.exactInputs,
        mechanical: { ...timed.exactInputs.mechanical, tierChanged: !timed.exactInputs.mechanical.tierChanged },
      },
    }
    expect(actionInputDigest({ ...payload.inputs.manifest, operands: changed })).not.toBe(payload.inputs.fingerprint)
    expect(actionReceiptPayloadSchema.safeParse({ ...payload, exactInputs: changed.exactInputs }).success).toBe(false)
    expect(
      actionReceiptPayloadSchema.safeParse({ ...assessment.result.payload, exactInputs: changed.exactInputs }).success,
    ).toBe(false)
    expect(actionInputManifestSchema.safeParse({ ...payload.inputs.manifest, operands: undefined }).success).toBe(false)
    expect(actionInputManifestSchema.safeParse({ ...payload.inputs.manifest, purpose: 'plan' }).success).toBe(false)
    const acceptedRef = operands.exactInputs.accepted.ref
    const wrongRef = {
      ...operands,
      exactInputs: {
        ...operands.exactInputs,
        accepted: { ...operands.exactInputs.accepted, ref: { ...acceptedRef, version: 'f'.repeat(64) } },
      },
    }
    expect(actionInputManifestSchema.safeParse({ ...payload.inputs.manifest, operands: wrongRef }).success).toBe(false)
    const request = {
      actionId: 'action',
      purpose: 'assess-spec',
      subject: payload.inputs.manifest.subject,
      code: payload.inputs.manifest.code,
      stageSources: [],
      expandedContext: [],
      operands,
    }
    expect(actionRequestSchema.safeParse(request).success).toBe(true)
    expect(actionRequestSchema.safeParse({ ...request, operands: undefined }).success).toBe(false)
    expect(actionRequestSchema.safeParse({ ...request, purpose: 'plan' }).success).toBe(false)
  })

  test('binds native CI observations and rejects missing or wrong-purpose operands', () => {
    const mandated = shippedFeatureMandate()
    const accepted = mandateAssessmentState(mandated)
    const assessment = assessFixture(
      mandated,
      'ci-operand-base',
      accepted,
      proposedAssessmentState(accepted, { body: 'proposal' }),
      'material',
      [history([mandated])],
    )
    const source = assessment.result.payload.inputs.manifest
    const observed = {
      candidateGitSHA: 'a'.repeat(40),
      scope: SCOPE,
      failures: [{ name: 'build', source: 'check-run', observationId: '1', conclusion: 'failure' }],
    }
    const evidenceDigest = failedCheckEvidenceDigest(observed)
    if (evidenceDigest === null) throw new Error('expected a check evidence digest')
    const exactInputs = { ...observed, failedChecks: ['build'], evidenceDigest }
    const operands = { action: 'attribute-ci' as const, exactInputs }
    const manifest = { ...source, purpose: 'attribute-ci' as const, operands }
    expect(actionInputManifestSchema.safeParse(manifest).success).toBe(true)
    expect(actionInputManifestSchema.safeParse({ ...manifest, operands: undefined }).success).toBe(false)
    expect(actionInputManifestSchema.safeParse({ ...manifest, operands: source.operands }).success).toBe(false)
    const rerun = { ...observed, failures: [{ ...observed.failures[0], observationId: '2' }] }
    const rerunDigest = failedCheckEvidenceDigest(rerun)
    if (rerunDigest === null) throw new Error('expected a rerun check evidence digest')
    const changed = {
      ...operands,
      exactInputs: { ...exactInputs, ...rerun, evidenceDigest: rerunDigest },
    }
    expect(actionInputDigest({ ...manifest, operands: changed })).not.toBe(actionInputDigest(manifest))
    const request = {
      actionId: 'ci',
      purpose: 'attribute-ci',
      subject: manifest.subject,
      code: manifest.code,
      stageSources: [],
      expandedContext: [],
      operands,
    }
    expect(actionRequestSchema.safeParse(request).success).toBe(true)
    expect(actionRequestSchema.safeParse({ ...request, operands: undefined }).success).toBe(false)
    expect(actionRequestSchema.safeParse({ ...request, operands: source.operands }).success).toBe(false)
  })

  test('requires a fresh authenticated assessment when the live Spec changes after an accepted material decision', async () => {
    const mandated = nativeMandate()
    const initial = mandateAssessmentState(mandated)
    const bodyB = strictSpecBody('material body B')
    const bodyC = strictSpecBody('material body C')
    const historical = assessFixture(mandated, 'material-a-b', initial, nativeProposal(initial, bodyB), 'material', [
      history([mandated]),
    ])
    const accepted = acceptMaterialFixture(mandated, 'accept-material-a-b', historical)
    const afterHistorical = acceptedMaterialState(historical, accepted)
    const live = assessFixture(
      mandated,
      'material-b-c',
      afterHistorical,
      nativeProposal(afterHistorical, bodyC),
      'material',
      [history([mandated, historical.start, historical.result, accepted])],
    )
    const staleRecords = [mandated, historical.start, historical.result, accepted]
    const staleEvidence = await nativeEvidence(history(staleRecords), bodyC, '2026-10-21T00:00:00Z')
    const liveFacts = currentFacts(mandated, live.proposed)
    expect(reconstructWorkflow({ evidence: staleEvidence, facts: liveFacts, decisions: decisions() })).toMatchObject({
      status: 'action',
      action: 'assess-spec',
      mandateId: mandated.recordId,
    })
    expect(
      reconstructWorkflow({
        evidence: await nativeEvidence(history([...staleRecords, live.start]), bodyC, '2026-10-21T00:00:00Z'),
        facts: liveFacts,
        decisions: decisions(),
      }),
    ).toMatchObject({ status: 'blocked', reason: 'action-uncertain' })
  })
  test('keeps a pending authenticated material assessment through date-only current metadata drift', async () => {
    const mandated = nativeMandate()
    const initial = mandateAssessmentState(mandated)
    const body = strictSpecBody('material body with unchanged canonical content')
    const pending = assessFixture(mandated, 'date-only-material', initial, nativeProposal(initial, body), 'material', [
      history([mandated]),
    ])
    const dateOnlyCurrent = {
      ...pending.proposed,
      snapshot: {
        ...pending.proposed.snapshot,
        raw: { ...pending.proposed.snapshot.raw, lastEditedAt: '2026-10-22T00:00:00Z' },
      },
    }
    const issueHistory = history([mandated, pending.start, pending.result])
    const histories = [issueHistory]
    expect(
      reconstructWorkflow({
        evidence: await nativeEvidence(issueHistory, body, '2026-10-22T00:00:00Z'),
        facts: currentFacts(mandated, dateOnlyCurrent),
        decisions: decisions(),
      }),
    ).toMatchObject({ status: 'blocked', reason: 'spec-decision-required' })
    expect(
      prepareMaterialAcceptance({
        uw: SCOPE,
        operationId: 'op-date-only-accept',
        histories,
        mandate: mandated,
        currentProposed: dateOnlyCurrent,
        identityAllocations: mandated.payload.ownSpec.identityAllocations,
      }),
    ).toMatchObject({ ok: true })
  })
})
