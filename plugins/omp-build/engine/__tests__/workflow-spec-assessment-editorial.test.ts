import { describe, expect, test } from 'vitest'
import { strictSpecBody } from '../../skills/feature/testing/epic-driver/epic-driver-records.ts'
import { actionInputDigest } from '../action-input.ts'
import { buildRecord } from '../record-construction.ts'
import { resolveAcceptedSpec } from '../workflow-accepted-spec.ts'
import { selectApplicableMandate } from '../workflow-mandate-admission.ts'
import { reconstructWorkflow } from '../workflow-reconstruction-admission.ts'
import {
  nativeEvidence,
  nativeInitialBody,
  nativeMandate,
  nativeProposal,
  parsedNativeSpec,
  workflowFixtures,
} from './workflow-spec-assessment-native-fixture.ts'
import {
  acceptedAssessmentState,
  assessFixture,
  currentFacts,
  decisions,
  mandateAssessmentState,
} from './workflow-spec-assessment-support.ts'
import { history, must, SCOPE } from './workflow-test-support.ts'

describe('workflow Spec assessment behavior', () => {
  test('requires a material decision for an editorial assessment of a tier change', async () => {
    const mandated = nativeMandate()
    const accepted = mandateAssessmentState(mandated)
    const proposed = {
      snapshot: accepted.snapshot,
      tier: 'F-lite' as const,
      children: accepted.children,
      inheritedOwnSpecRefs: accepted.inheritedOwnSpecRefs,
      coverage: accepted.coverage,
    }
    const assessment = assessFixture(mandated, 'editorial-tier-change', accepted, proposed, 'editorial', [
      history([mandated]),
    ])
    const issue = history([mandated, assessment.start, assessment.result])

    expect(accepted.tier).toBe('S')
    expect(assessment.result.payload.exactInputs.mechanical).toMatchObject({
      added: [],
      removed: [],
      exclusionsChanged: false,
      tierChanged: true,
      childrenChanged: false,
    })
    expect(assessment.proposed.snapshot.spec).toEqual(accepted.snapshot.spec)
    expect(resolveAcceptedSpec(mandated, [issue])).toMatchObject({ ok: true, spec: accepted })
    expect(
      reconstructWorkflow({
        evidence: await nativeEvidence(issue, nativeInitialBody, 'F-lite'),
        facts: currentFacts(mandated, assessment.proposed),
        decisions: decisions(),
      }),
    ).toMatchObject({ status: 'blocked', reason: 'spec-decision-required' })
  })

  test('refuses an authenticated editorial tier assessment with a false mechanical delta', async () => {
    const mandated = nativeMandate()
    const accepted = mandateAssessmentState(mandated)
    const proposed = {
      snapshot: accepted.snapshot,
      tier: 'F-lite' as const,
      children: accepted.children,
      inheritedOwnSpecRefs: accepted.inheritedOwnSpecRefs,
      coverage: accepted.coverage,
    }
    const assessment = assessFixture(mandated, 'false-editorial-tier-delta', accepted, proposed, 'editorial', [
      history([mandated]),
    ])
    if (assessment.start.kind !== 'action-receipt') throw new Error('expected assessment start fixture')
    const startPayload = assessment.start.payload
    if (startPayload.phase !== 'start' || startPayload.action !== 'assess-spec')
      throw new Error('expected assessment start fixture')
    const exactInputs = {
      ...assessment.result.payload.exactInputs,
      mechanical: { ...assessment.result.payload.exactInputs.mechanical, tierChanged: false },
    }
    const manifest = {
      ...startPayload.inputs.manifest,
      operands: { action: 'assess-spec' as const, origin: { kind: 'native-current' as const }, exactInputs },
    }
    const inputs = { ...startPayload.inputs, manifest, fingerprint: actionInputDigest(manifest) }
    const start = must(buildRecord({ ...assessment.start, payload: { ...startPayload, inputs, exactInputs } }))
    const result = must(
      buildRecord({ ...assessment.result, payload: { ...assessment.result.payload, inputs, exactInputs } }),
    )
    const issue = history([mandated, start, result])

    expect(accepted.tier).toBe('S')
    expect(proposed.tier).toBe('F-lite')
    expect(resolveAcceptedSpec(mandated, [issue])).toMatchObject({
      ok: false,
      evidence: [{ message: 'Spec assessment mechanical delta does not match its exact states' }],
    })
    expect(
      reconstructWorkflow({
        evidence: await nativeEvidence(issue, nativeInitialBody, 'F-lite'),
        facts: currentFacts(mandated, proposed),
        decisions: decisions(),
      }),
    ).toMatchObject({
      status: 'terminal',
      reason: 'spec-ambiguous',
      evidence: [{ message: 'Spec assessment mechanical delta does not match its exact states' }],
    })
  })

  test('accepts a genuinely non-mechanical editorial assessment without a material decision', async () => {
    const mandated = nativeMandate()
    const accepted = mandateAssessmentState(mandated)
    const body = strictSpecBody('editorially revised wording')
    const proposed = nativeProposal(accepted, body)
    const assessment = assessFixture(mandated, 'editorial-wording-only', accepted, proposed, 'editorial', [
      history([mandated]),
    ])
    const issue = history([mandated, assessment.start, assessment.result])

    expect(assessment.result.payload.exactInputs.mechanical).toMatchObject({
      added: [],
      removed: [],
      exclusionsChanged: false,
      tierChanged: false,
      childrenChanged: false,
    })
    expect(resolveAcceptedSpec(mandated, [issue])).toMatchObject({
      ok: true,
      spec: { ref: { version: assessment.currentVersion, sourceAccepted: { recordId: assessment.result.recordId } } },
    })
    expect(
      reconstructWorkflow({
        evidence: await nativeEvidence(issue, body, 'S'),
        facts: currentFacts(mandated, assessment.proposed),
        decisions: decisions(),
      }),
    ).toMatchObject({ status: 'action', mandateId: mandated.recordId })
  })

  test('keeps an editorial return as the current accepted source rather than a competing assessment', async () => {
    const mandated = nativeMandate()
    const initial = mandateAssessmentState(mandated)
    const bodyB = strictSpecBody('editorial body B')
    const bodyC = strictSpecBody('editorial body C')
    const first = assessFixture(mandated, 'editorial-a-b', initial, nativeProposal(initial, bodyB), 'editorial', [
      history([mandated]),
    ])
    const afterFirst = acceptedAssessmentState(first)
    const second = assessFixture(
      mandated,
      'editorial-b-c',
      afterFirst,
      nativeProposal(afterFirst, bodyC),
      'editorial',
      [history([mandated, first.start, first.result])],
    )
    const afterSecond = acceptedAssessmentState(second)
    const returned = assessFixture(
      mandated,
      'editorial-c-b',
      afterSecond,
      nativeProposal(afterSecond, bodyB),
      'editorial',
      [history([mandated, first.start, first.result, second.start, second.result])],
    )
    const evidence = await nativeEvidence(
      history([mandated, first.start, first.result, second.start, second.result, returned.start, returned.result]),
      bodyB,
      'S',
    )
    expect(resolveAcceptedSpec(mandated, [evidence.issue])).toMatchObject({
      ok: true,
      spec: { ref: { version: returned.currentVersion }, snapshot: { spec: { version: returned.currentVersion } } },
    })
    expect(
      reconstructWorkflow({
        evidence,
        facts: currentFacts(mandated, returned.proposed),
        decisions: decisions(),
      }),
    ).toMatchObject({ status: 'action', mandateId: mandated.recordId })
  })

  test('does not let a predecessor material assessment govern its selected successor', async () => {
    const predecessor = nativeMandate()
    const predecessorState = mandateAssessmentState(predecessor)
    const successorBody = strictSpecBody('successor accepts the current Spec')
    const nextBody = strictSpecBody('next Spec')
    const stale = assessFixture(
      predecessor,
      'predecessor-material',
      predecessorState,
      nativeProposal(predecessorState, successorBody),
      'material',
      [history([predecessor])],
    )
    const abandoned = must(
      buildRecord({
        version: 1,
        repository: SCOPE.repository,
        target: SCOPE.target,
        recordId: 'abandon-predecessor',
        runId: 'run-1',
        operationId: 'op-abandon-predecessor',
        kind: 'operator-control',
        payload: {
          control: 'abandon',
          controlId: 'abandon-predecessor',
          mandate: { scope: SCOPE, recordId: predecessor.recordId, kind: 'mandate' },
          predecessor: null,
        },
      }),
    )
    const successor = workflowFixtures.featureMandate(SCOPE, {
      recordId: 'mandate-successor',
      runId: 'run-1',
      operationId: 'op-mandate-successor',
      branch: 'feature/bounded',
      base: 'main',
      lineageHead: null,
      body: successorBody,
      ownSpec: workflowFixtures.ownSpecFromSnapshot(SCOPE, parsedNativeSpec(successorBody)),
      antecedent: { scope: SCOPE, recordId: predecessor.recordId, kind: 'mandate' },
    })
    const selected = must(
      buildRecord({
        version: 1,
        repository: SCOPE.repository,
        target: SCOPE.target,
        recordId: 'select-successor',
        runId: 'run-1',
        operationId: 'op-select-successor',
        kind: 'operator-control',
        payload: {
          control: 'select-successor',
          controlId: 'select-successor',
          mandate: { scope: SCOPE, recordId: predecessor.recordId, kind: 'mandate' },
          predecessor: { scope: SCOPE, recordId: predecessor.recordId, kind: 'mandate' },
          successor: { scope: SCOPE, recordId: successor.recordId, kind: 'mandate' },
        },
      }),
    )
    const evidence = await nativeEvidence(
      history([predecessor, stale.start, stale.result, abandoned, successor, selected]),
      successorBody,
      'S',
    )
    expect(selectApplicableMandate(evidence.issue, [], evidence.causal)).toMatchObject({
      status: 'applicable',
      mandate: { recordId: successor.recordId },
    })
    const successorState = mandateAssessmentState(successor)
    const successorCurrent = {
      snapshot: successor.payload.ownSpec.snapshot,
      tier: successor.payload.tier,
      children: successor.payload.children,
      inheritedOwnSpecRefs: successor.payload.inheritedOwnSpecRefs,
      coverage: successor.payload.coverage,
    }
    expect(
      reconstructWorkflow({
        evidence,
        facts: currentFacts(successor, successorCurrent),
        decisions: decisions(),
      }),
    ).toMatchObject({ status: 'action', mandateId: successor.recordId })

    const first = assessFixture(
      successor,
      'successor-material-a',
      successorState,
      nativeProposal(successorState, nextBody),
      'material',
      [evidence.issue],
    )
    const second = assessFixture(
      successor,
      'successor-material-b',
      successorState,
      nativeProposal(successorState, nextBody),
      'material',
      [evidence.issue],
    )
    expect(
      reconstructWorkflow({
        evidence: await nativeEvidence(
          history([
            predecessor,
            stale.start,
            stale.result,
            abandoned,
            successor,
            selected,
            first.start,
            first.result,
            second.start,
            second.result,
          ]),
          nextBody,
          'S',
        ),
        facts: currentFacts(successor, first.proposed),
        decisions: decisions(),
      }),
    ).toMatchObject({ status: 'terminal', reason: 'spec-ambiguous' })
  })
})
