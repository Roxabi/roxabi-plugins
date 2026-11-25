import { describe, expect, test } from 'vitest'
import { parseIssueSpecBody, rawSource } from '../../adapters/github-native/uw-spec.ts'
import { strictSpecBody } from '../../skills/feature/testing/epic-driver/epic-driver-records.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { actionInputDigest, canonicalActionOperands } from '../action-input.ts'
import { actionInputManifestSchema } from '../action-input-schema.ts'
import { parseRecord } from '../record-construction.ts'
import { failedCheckEvidenceDigest } from '../record-digests.ts'
import { prepareMaterialAcceptance } from '../workflow-material-acceptance.ts'
import { actionReceiptPayloadSchema } from '../workflow-receipt-schema.ts'
import {
  type AssessmentState,
  assessFixture,
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
  })

  test('keeps a pending authenticated material assessment through date-only current metadata drift', () => {
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
