import { describe, expect, test } from 'vitest'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { buildRecord } from '../record-construction.ts'
import { specDigest } from '../record-digests.ts'
import type { Scope } from '../record-values.ts'
import { resolveAcceptedSpec } from '../workflow-accepted-spec.ts'
import { resolveBoundWork } from '../workflow-bound-work-resolution.ts'
import { selectWorkflowBinding } from '../workflow-pr-binding.ts'
import { assessFixture, mandateAssessmentState, proposedAssessmentState } from './workflow-spec-assessment-support.ts'
import { BODY, binding, DIGEST, featureMandate, history, mandate, SCOPE } from './workflow-test-support.ts'

describe('workflow bound work behavior', () => {
  test('returns the exact accepted own Spec and refuses malformed or inactive bindings', () => {
    const mandated = featureMandate()
    const current = 'ship the bounded workflow, clarified'
    const accepted = mandateAssessmentState(mandated)
    const proposed = proposedAssessmentState(accepted, { body: current })
    const assessment = assessFixture(mandated, 'assess-1', accepted, proposed, 'editorial')
    const pr: Scope = { repository: 'acme/app', target: 'acme/app#99' }
    const native = { branch: 'feature/bounded', base: 'main' }
    const issue = history([mandated, assessment.start, assessment.result])
    const bound = resolveBoundWork({
      use: 'review',
      explicitSelection: true,
      pullRequest: pr,
      histories: [issue, history([binding(mandated, pr)], pr)],
      native,
      currentSpec: proposed,
    })
    expect(bound).toMatchObject({
      status: 'applicable',
      drift: 'settled',
      permissions: { landing: true, correct: true },
      acceptedSpec: {
        snapshot: assessment.result.payload.exactInputs.proposed.snapshot,
        tier: 'S',
      },
      configIdentity: { additionalRequirements: [], digest: DIGEST },
    })
    expect(resolveAcceptedSpec(mandated, [issue])).toMatchObject({
      ok: true,
      spec: {
        snapshot: assessment.result.payload.exactInputs.proposed.snapshot,
        chain: [{ kind: 'mandate' }, { kind: 'editorial', source: { recordId: 'assess-1' } }],
      },
    })
    expect(
      resolveBoundWork({
        use: 'review',
        explicitSelection: true,
        pullRequest: pr,
        histories: [history([], pr)],
        native,
      }),
    ).toEqual({
      status: 'standalone',
      binding: 'absent',
    })
    expect(
      resolveBoundWork({
        use: 'landing',
        explicitSelection: true,
        pullRequest: pr,
        histories: [history([], pr)],
        native,
      }),
    ).toMatchObject({
      status: 'refused',
      reason: 'missing',
    })
    expect(
      resolveBoundWork({
        use: 'review',
        explicitSelection: true,
        pullRequest: pr,
        histories: [history([binding(mandated, pr)], pr)],
        native,
      }),
    ).toMatchObject({
      status: 'refused',
      reason: 'incomplete',
    })
    const fixOnly = mandate()
    expect(
      resolveBoundWork({
        use: 'landing',
        explicitSelection: false,
        pullRequest: pr,
        histories: [history([fixOnly]), history([binding(fixOnly, pr)], pr)],
        native,
      }),
    ).toMatchObject({ status: 'refused', reason: 'fix-only' })
  })
  test('foreign binding observations cannot compete with bound or standalone review', () => {
    const mandated = featureMandate()
    const pr: Scope = { repository: 'acme/app', target: 'acme/app#99' }
    const native = { branch: 'feature/bounded', base: 'main' }
    const boundHistory = history([binding(mandated, pr)], pr)
    const authentic = boundHistory.operations[0]
    if (authentic === undefined) throw new Error('fixture requires binding')
    const foreign = { ...authentic, authority: 'foreign' as const, status: 'incomplete' as const, record: null }
    const noisy = { ...boundHistory, operations: [authentic, foreign] }
    const input = { explicitSelection: true, pullRequest: pr, native }
    expect(resolveBoundWork({ ...input, use: 'review', histories: [history([mandated]), noisy] })).toMatchObject({
      status: 'applicable',
    })
    const foreignOnly = { ...boundHistory, operations: [foreign] }
    expect(resolveBoundWork({ ...input, use: 'review', histories: [foreignOnly] })).toEqual({
      status: 'standalone',
      binding: 'absent',
    })
    expect(resolveBoundWork({ ...input, use: 'landing', histories: [foreignOnly] })).toMatchObject({
      status: 'refused',
      reason: 'missing',
    })
  })
  test('binding ignores foreign successor controls but refuses incomplete expected-author controls', () => {
    const mandated = featureMandate()
    const pr: Scope = { repository: 'acme/app', target: 'acme/app#99' }
    const predecessor = { scope: SCOPE, recordId: mandated.recordId, kind: 'mandate' as const }
    const successor = { scope: SCOPE, recordId: 'other-mandate', kind: 'mandate' as const }
    const built = buildRecord({
      version: 1,
      ...SCOPE,
      recordId: 'foreign-select',
      runId: 'run-1',
      operationId: 'op-foreign-select',
      kind: 'operator-control',
      payload: { control: 'select-successor', controlId: 'foreign-select', mandate: successor, predecessor, successor },
    })
    if (!built.ok) throw new Error('fixture requires successor control')
    const control = history([built.value]).operations[0]
    if (control === undefined) throw new Error('fixture requires control observation')
    const home = history([mandated])
    const prHistory = history([binding(mandated, pr)], pr)
    const input = {
      pullRequest: pr,
      native: { branch: 'feature/bounded', base: 'main' },
      histories: [home, prHistory],
    }
    const foreign = { ...control, authority: 'foreign' as const }
    expect(
      selectWorkflowBinding({
        ...input,
        histories: [{ ...home, operations: [...home.operations, foreign] }, prHistory],
      }),
    ).toMatchObject({ status: 'bound', binding: { recordId: `binding-${mandated.recordId}` } })
    const invalid = { ...control, status: 'invalid' as const }
    expect(
      selectWorkflowBinding({
        ...input,
        histories: [{ ...home, operations: [...home.operations, invalid] }, prHistory],
      }),
    ).toMatchObject({ status: 'incomplete' })
  })
  test('ignores child read-date drift while preserving canonical child drift detection', () => {
    const fixtures = roxabiWorkflowFixtures()
    const child: Scope = { repository: SCOPE.repository, target: 'acme/app#43' }
    const mandated = fixtures.epicMandate(SCOPE, [fixtures.childSnapshot(child, 'child C1')], {
      recordId: 'epic-bound',
      runId: 'bound001',
      operationId: 'op-epic-bound',
      body: BODY,
    })
    const accepted = mandateAssessmentState(mandated)
    const commitment = accepted.children[0]
    if (commitment === undefined) throw new Error('fixture epic has no child commitment')
    const pr: Scope = { repository: SCOPE.repository, target: 'acme/app#99' }
    const input = {
      use: 'review' as const,
      explicitSelection: true,
      pullRequest: pr,
      histories: [history([mandated]), history([binding(mandated, pr)], pr)],
      native: { branch: 'feature/bounded', base: 'main' },
    }
    const datedOnly = proposedAssessmentState(accepted, {
      body: BODY,
      children: [
        {
          ...commitment,
          snapshot: {
            ...commitment.snapshot,
            raw: { ...commitment.snapshot.raw, lastEditedAt: '2026-10-22T00:00:00Z' },
          },
        },
      ],
    })
    expect(resolveBoundWork({ ...input, currentSpec: datedOnly })).toMatchObject({
      status: 'applicable',
      drift: 'settled',
    })
    const childVersionChanged = proposedAssessmentState(accepted, {
      body: BODY,
      children: [fixtures.childSnapshot(child, 'child C2')],
    })
    expect(resolveBoundWork({ ...input, currentSpec: childVersionChanged })).toMatchObject({
      status: 'applicable',
      drift: 'differs',
    })
    const childTierChanged = proposedAssessmentState(accepted, {
      body: BODY,
      children: [{ ...commitment, tier: 'F-lite' }],
    })
    expect(resolveBoundWork({ ...input, currentSpec: childTierChanged })).toMatchObject({
      status: 'applicable',
      drift: 'differs',
    })
    const changedRawBody = 'child C1 rewritten'
    const childRawChanged = proposedAssessmentState(accepted, {
      body: BODY,
      children: [
        {
          ...commitment,
          snapshot: {
            ...commitment.snapshot,
            raw: {
              ...commitment.snapshot.raw,
              body: changedRawBody,
              bodySha256: specDigest(changedRawBody),
            },
          },
        },
      ],
    })
    expect(resolveBoundWork({ ...input, currentSpec: childRawChanged })).toMatchObject({
      status: 'applicable',
      drift: 'differs',
    })
  })
})
