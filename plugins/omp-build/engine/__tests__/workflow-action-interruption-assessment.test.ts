import { describe, expect, test } from 'vitest'
import { parseIssueSpecBody, rawSource } from '../../adapters/github-native/uw-spec.ts'
import { strictSpecBody } from '../../skills/feature/testing/epic-driver/epic-driver-records.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import type { DecodedHistory } from '../history-schema.ts'
import { parseRecord } from '../record-construction.ts'
import { resolveAcceptedSpec } from '../workflow-accepted-spec.ts'
import { classifyAttempts } from '../workflow-action-interruption.ts'
import { appendRecords, interruptedResult, interruptionResolution, receiptOf } from './workflow-interruption-support.ts'
import { assessFixture, mandateAssessmentState, shippedFeatureMandate } from './workflow-spec-assessment-support.ts'
import { history, must, pauseControls, SCOPE } from './workflow-test-support.ts'

const workflowFixtures = roxabiWorkflowFixtures()
const nativeInitialBody = strictSpecBody('ship the bounded workflow')

function nativeMandate() {
  const parsed = parseIssueSpecBody({
    uw: SCOPE,
    raw: rawSource(SCOPE.target, nativeInitialBody, '2026-10-21T00:00:00Z'),
  })
  if (parsed.status !== 'conformant') throw new Error('Expected a conformant declared Spec')
  const mandate = shippedFeatureMandate()
  const record = must(
    parseRecord({
      ...mandate,
      payload: { ...mandate.payload, ownSpec: workflowFixtures.ownSpecFromSnapshot(SCOPE, parsed.snapshot) },
    }),
  )
  if (record.kind !== 'mandate') throw new Error('Expected a native mandate')
  return record
}

function interruptedAssessmentWorld() {
  const mandated = nativeMandate()
  const accepted = mandateAssessmentState(mandated)
  const proposed = {
    snapshot: accepted.snapshot,
    tier: 'F-lite' as const,
    children: accepted.children,
    inheritedOwnSpecRefs: accepted.inheritedOwnSpecRefs,
    coverage: accepted.coverage,
  }
  const assessment = assessFixture(
    mandated,
    'interrupted-assessment',
    accepted,
    proposed,
    null,
    [history([mandated])],
    { completion: 'incomplete', strict: 'absent' },
  )
  const classify = (issue: DecodedHistory) =>
    classifyAttempts({ histories: [issue], scan: [issue], actions: ['assess-spec'] })
  return {
    mandated,
    start: receiptOf(assessment.start),
    result: interruptedResult(receiptOf(assessment.result)),
    classify,
  }
}

describe('interrupted Spec assessment', () => {
  test('recognizes an interrupted assessment as distinct from an orphan', () => {
    const world = interruptedAssessmentWorld()
    const attempts = world.classify(history([world.mandated, world.start, world.result]))
    expect(attempts).toMatchObject({
      ok: true,
      value: { unresolved: [{ kind: 'interrupted', action: 'assess-spec' }] },
    })
  })

  test('recognizes an orphan assessment START', () => {
    const world = interruptedAssessmentWorld()
    const attempts = world.classify(history([world.mandated, world.start]))
    expect(attempts).toMatchObject({ ok: true, value: { unresolved: [{ kind: 'orphan', action: 'assess-spec' }] } })
  })

  test('excludes a resolved assessment interruption without advancing authority', () => {
    const world = interruptedAssessmentWorld()
    const pause = pauseControls(world.mandated, 'assessment-pause')
    const resolution = interruptionResolution({
      mandate: world.mandated,
      pause: pause.confirmed,
      start: world.start,
      result: world.result,
    })
    const issue = appendRecords(
      history([world.mandated, world.start, world.result, pause.requested, pause.confirmed]),
      [resolution, pause.resumed],
    )
    const original = resolveAcceptedSpec(world.mandated, [history([world.mandated])])
    expect(original.ok).toBe(true)
    expect(resolveAcceptedSpec(world.mandated, [issue])).toEqual(original)
    expect(world.classify(issue)).toMatchObject({ ok: true, value: { unresolved: [] } })
  })

  test('excludes a resolved orphan assessment without advancing authority', () => {
    const world = interruptedAssessmentWorld()
    const pause = pauseControls(world.mandated, 'orphan-assessment-pause')
    const resolution = interruptionResolution({
      mandate: world.mandated,
      pause: pause.confirmed,
      start: world.start,
      result: null,
    })
    const issue = appendRecords(history([world.mandated, world.start, pause.requested, pause.confirmed]), [
      resolution,
      pause.resumed,
    ])
    const original = resolveAcceptedSpec(world.mandated, [history([world.mandated])])
    expect(original.ok).toBe(true)
    expect(resolveAcceptedSpec(world.mandated, [issue])).toEqual(original)
    expect(world.classify(issue)).toMatchObject({ ok: true, value: { unresolved: [] } })
  })

  test('refuses an invalid resolution instead of skipping the interrupted assessment', () => {
    const world = interruptedAssessmentWorld()
    const pause = pauseControls(world.mandated, 'invalid-assessment-pause')
    const resolution = interruptionResolution({
      mandate: world.mandated,
      pause: pause.confirmed,
      start: world.start,
      result: world.result,
      payload: (payload) => ({ ...payload, proposalDigest: '0'.repeat(64) }),
    })
    const issue = appendRecords(
      history([world.mandated, world.start, world.result, pause.requested, pause.confirmed]),
      [resolution],
    )
    expect(resolveAcceptedSpec(world.mandated, [issue])).toMatchObject({
      ok: false,
      evidence: expect.arrayContaining([expect.objectContaining({ code: 'interruption-resolution-invalid' })]),
    })
  })
})
