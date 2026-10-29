import { describe, expect, test } from 'vitest'
import { actionInputDigest, canonicalActionOperands } from '../action-input.ts'
import { actionInputManifestSchema } from '../action-input-schema.ts'
import { failedCheckEvidenceDigest } from '../record-digests.ts'
import { actionRequestSchema } from '../uw-action-command-schema.ts'
import { prepareMaterialAcceptance } from '../workflow-material-acceptance.ts'
import { actionReceiptPayloadSchema } from '../workflow-receipt-schema.ts'
import { reconstructWorkflow } from '../workflow-reconstruction-admission.ts'
import {
  acceptedMaterialState,
  acceptMaterialFixture,
  assessFixture,
  currentFacts,
  decisions,
  mandateAssessmentState,
  proposedAssessmentState,
  shippedFeatureMandate,
} from './workflow-spec-assessment-support.ts'
import { history, SCOPE } from './workflow-test-support.ts'

describe('workflow Spec assessment operand binding and freshness', () => {
  test('seals exact assessment operands and ignores only observed timestamps in fingerprints', () => {
    const mandated = shippedFeatureMandate()
    const accepted = mandateAssessmentState(mandated)
    const child = {
      scope: SCOPE,
      specVersion: accepted.snapshot.spec.version,
      snapshot: accepted.snapshot,
      tier: accepted.tier,
    }
    const state = { ...accepted, children: [child] }
    const assessment = assessFixture(
      mandated,
      'operand-binding',
      state,
      proposedAssessmentState(state, { body: 'new proposal' }),
      'material',
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
      children: value.children.map((item) => ({ ...item, snapshot: updated(item.snapshot) })),
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

  test('requires a fresh authenticated assessment when the live Spec changes after an accepted material decision', () => {
    const mandated = shippedFeatureMandate()
    const initial = mandateAssessmentState(mandated)
    const historical = assessFixture(
      mandated,
      'material-a-b',
      initial,
      proposedAssessmentState(initial, { body: 'material body B' }),
      'material',
    )
    const accepted = acceptMaterialFixture(mandated, 'accept-material-a-b', historical)
    const afterHistorical = acceptedMaterialState(historical, accepted)
    const live = assessFixture(
      mandated,
      'material-b-c',
      afterHistorical,
      proposedAssessmentState(afterHistorical, { body: 'material body C' }),
      'material',
    )
    const staleRecords = [mandated, historical.start, historical.result, accepted]
    const staleEvidence = {
      issue: history(staleRecords),
      pullRequest: null,
      parents: [],
    }
    const liveFacts = currentFacts(mandated, live.proposed)
    expect(reconstructWorkflow({ evidence: staleEvidence, facts: liveFacts, decisions: decisions() })).toMatchObject({
      status: 'action',
      action: 'assess-spec',
      mandateId: mandated.recordId,
    })
    expect(
      reconstructWorkflow({
        evidence: { ...staleEvidence, issue: history([...staleRecords, live.start]) },
        facts: liveFacts,
        decisions: decisions(),
      }),
    ).toMatchObject({ status: 'blocked', reason: 'action-uncertain' })
  })
  test('keeps a pending authenticated material assessment through date-only current metadata drift', () => {
    const mandated = shippedFeatureMandate()
    const initial = mandateAssessmentState(mandated)
    const pending = assessFixture(
      mandated,
      'date-only-material',
      initial,
      proposedAssessmentState(initial, { body: 'material body with unchanged canonical content' }),
      'material',
    )
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
        evidence: { issue: issueHistory, pullRequest: null, parents: [] },
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
