import { describe, expect, test } from 'vitest'
import { parseIssueSpecBody, rawSource } from '../../adapters/github-native/uw-spec.ts'
import { strictSpecBody } from '../../skills/feature/testing/epic-driver/epic-driver-records.ts'
import { observeFixtureNativeWorld } from '../../testing/action-input-fixtures.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import type { DecodedHistory } from '../history-schema.ts'
import { parseRecord } from '../record-construction.ts'
import { resolveAcceptedSpec } from '../workflow-accepted-spec.ts'
import { reconstructWorkflow } from '../workflow-reconstruction-admission.ts'
import {
  appendRecords,
  evidenceCodes,
  interruptedResult,
  interruptionResolution,
  receiptOf,
} from './workflow-interruption-support.ts'
import {
  assessFixture,
  currentFacts,
  decisions,
  mandateAssessmentState,
  shippedFeatureMandate,
} from './workflow-spec-assessment-support.ts'
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

async function nativeEvidence(issue: DecodedHistory) {
  const causal = await observeFixtureNativeWorld({
    root: SCOPE,
    nodes: [
      {
        scope: SCOPE,
        title: 'Bounded workflow',
        body: nativeInitialBody,
        updatedAt: '2026-10-21T00:00:00Z',
        labels: ['size:F-lite'],
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

/** A tier-only Spec change that requires assess-spec, whose single attempt stopped without output. */
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
  const decide = async (issue: DecodedHistory) =>
    reconstructWorkflow({
      evidence: await nativeEvidence(issue),
      facts: currentFacts(mandated, assessment.proposed),
      decisions: decisions(),
    })
  return {
    mandated,
    start: receiptOf(assessment.start),
    result: interruptedResult(receiptOf(assessment.result)),
    decide,
  }
}

describe('interrupted Spec assessment', () => {
  test('blocks an interrupted assessment as interrupted, not as a terminal Spec ambiguity', async () => {
    const world = interruptedAssessmentWorld()
    const decision = await world.decide(history([world.mandated, world.start, world.result]))
    expect(decision).toMatchObject({ status: 'blocked', reason: 'action-interrupted' })
    expect(decision).not.toMatchObject({ status: 'terminal' })
    expect(evidenceCodes(decision)).toContain('action-interrupted')
  })

  test('keeps an orphan assessment START uncertain', async () => {
    const world = interruptedAssessmentWorld()
    const decision = await world.decide(history([world.mandated, world.start]))
    expect(decision).toMatchObject({ status: 'blocked', reason: 'action-uncertain' })
  })

  test('readmits assessment after a resolved interruption once the pause is lifted', async () => {
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
    expect(await world.decide(issue)).toMatchObject({ status: 'action', action: 'assess-spec' })
  })

  test('readmits an assessment after resolving an orphan without advancing accepted authority', async () => {
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
    expect(await world.decide(issue)).toMatchObject({ status: 'action', action: 'assess-spec' })
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
