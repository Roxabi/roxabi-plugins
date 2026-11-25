import { describe, expect, test } from 'vitest'
import { fixtureCausal } from '../../testing/action-input-fixtures.ts'
import type { DecodedHistory } from '../history-schema.ts'
import { parseRecord } from '../record-construction.ts'
import type { Scope } from '../record-values.ts'
import { resolveBoundWork } from '../workflow-bound-work-resolution.ts'
import { unliftedPause } from '../workflow-pause.ts'
import { binding, history, must, PARENT, pauseControls, SCOPE } from './workflow-test-support.ts'
import {
  childCommitment,
  featureMandate,
  landingFixtures,
  nativeBody,
  nativeCausal,
  parentNodes,
  parentSnapshot,
  rootNode,
} from './workflow-transition-native-fixture.ts'

describe('workflow transition pause behavior', () => {
  test('refuses unconfirmed own pauses and preserves successor pause controls', async () => {
    const pr: Scope = { repository: 'acme/app', target: 'acme/app#99' }
    const feature = featureMandate()
    const native = { branch: 'feature/bounded', base: 'main' }
    const bound = async (histories: DecodedHistory[], use: 'review' | 'correction') =>
      resolveBoundWork({
        use,
        explicitSelection: true,
        pullRequest: pr,
        histories,
        native,
        causal: await nativeCausal(histories, [rootNode]),
      })
    const ownFirstPause = pauseControls(feature, 'feature-first-pause')
    const ownResumed = [
      history([feature, ownFirstPause.requested, ownFirstPause.confirmed, ownFirstPause.resumed]),
      history([binding(feature, pr)], pr),
    ]
    expect(await bound(ownResumed, 'review')).toMatchObject({
      status: 'applicable',
      mandate: { recordId: feature.recordId },
    })
    const ownSecondPause = pauseControls(feature, 'feature-second-pause')
    const ownPending = [
      history([
        feature,
        ownFirstPause.requested,
        ownFirstPause.confirmed,
        ownFirstPause.resumed,
        ownSecondPause.requested,
      ]),
      history([binding(feature, pr)], pr),
    ]
    expect(await bound(ownPending, 'review')).toMatchObject({
      status: 'refused',
      reason: 'unconfirmed',
      evidence: [expect.objectContaining({ code: 'pause-unconfirmed' })],
    })
    expect(await bound(ownPending, 'correction')).toMatchObject({ status: 'refused', reason: 'unconfirmed' })
    const ownConfirmedHistory = history([
      feature,
      ownFirstPause.requested,
      ownFirstPause.confirmed,
      ownFirstPause.resumed,
      ownSecondPause.requested,
      ownSecondPause.confirmed,
    ])
    const ownConfirmed = [ownConfirmedHistory, history([binding(feature, pr)], pr)]
    expect(await bound(ownConfirmed, 'review')).toMatchObject({ status: 'refused', reason: 'paused' })
    expect(unliftedPause(ownConfirmedHistory, feature)?.recordId).toBe(ownSecondPause.confirmed.recordId)
    const antecedent = featureMandate()
    const antecedentPause = pauseControls(antecedent, 'antecedent-pause')
    const successor = must(
      parseRecord({
        ...antecedent,
        recordId: 'mandate-successor',
        operationId: 'op-mandate-successor',
        inputs: [antecedent.recordId, ...antecedent.inputs],
        payload: {
          ...antecedent.payload,
          antecedent: { scope: SCOPE, recordId: antecedent.recordId, kind: 'mandate' },
        },
      }),
    )
    if (successor.kind !== 'mandate') throw new Error('fixture is not a mandate')
    const abandonedAntecedent = must(
      parseRecord({
        version: 1,
        repository: SCOPE.repository,
        target: SCOPE.target,
        recordId: 'abandon-antecedent',
        runId: 'run-1',
        operationId: 'op-abandon-antecedent',
        kind: 'operator-control',
        inputs: [antecedent.recordId],
        payload: {
          control: 'abandon',
          controlId: 'abandon-antecedent',
          predecessor: null,
          mandate: { scope: SCOPE, recordId: antecedent.recordId, kind: 'mandate' },
        },
      }),
    )
    const selectedSuccessor = must(
      parseRecord({
        version: 1,
        repository: SCOPE.repository,
        target: SCOPE.target,
        recordId: 'select-successor',
        runId: 'run-1',
        operationId: 'op-select-successor',
        kind: 'operator-control',
        inputs: [antecedent.recordId, successor.recordId],
        payload: {
          control: 'select-successor',
          controlId: 'select-successor',
          predecessor: { scope: SCOPE, recordId: antecedent.recordId, kind: 'mandate' },
          mandate: { scope: SCOPE, recordId: antecedent.recordId, kind: 'mandate' },
          successor: { scope: SCOPE, recordId: successor.recordId, kind: 'mandate' },
        },
      }),
    )
    const successorPause = pauseControls(successor, 'successor-pause')
    const successorHistory = history([
      antecedent,
      antecedentPause.requested,
      antecedentPause.confirmed,
      antecedentPause.resumed,
      abandonedAntecedent,
      successor,
      selectedSuccessor,
      successorPause.requested,
      successorPause.confirmed,
    ])
    expect(unliftedPause(successorHistory, successor)?.recordId).toBe(successorPause.confirmed.recordId)
    const standaloneHistory = history([], pr)
    expect(
      resolveBoundWork({
        use: 'review',
        explicitSelection: true,
        pullRequest: pr,
        histories: [standaloneHistory],
        native,
        causal: fixtureCausal([standaloneHistory]),
      }),
    ).toEqual({ status: 'standalone', binding: 'absent' })
  })

  test('keeps parent pause cycles active for a child with a current accepted grant', async () => {
    const pr: Scope = { repository: 'acme/app', target: 'acme/app#99' }
    const childGrant = childCommitment
    const parent = landingFixtures.epicMandate(PARENT, [childGrant], {
      recordId: 'parent-pause-matrix',
      runId: 'run-parent-pause-matrix',
      operationId: 'op-parent-pause-matrix',
      body: nativeBody,
      ownSpec: landingFixtures.ownSpecFromSnapshot(PARENT, parentSnapshot),
    })
    const child = landingFixtures.featureMandate(SCOPE, {
      recordId: 'child-pause-matrix',
      runId: 'run-child-pause-matrix',
      operationId: 'op-child-pause-matrix',
      branch: 'feature/bounded',
      base: 'main',
      lineageHead: null,
      body: nativeBody,
      ownSpec: landingFixtures.ownSpecFromSnapshot(SCOPE, childGrant.snapshot),
      tier: childGrant.tier,
      parent: { scope: PARENT, recordId: parent.recordId, kind: 'mandate' },
      inheritedOwnSpecRefs: [
        {
          uw: PARENT,
          version: parent.payload.ownSpec.version,
          sourceAccepted: { scope: PARENT, recordId: parent.recordId, kind: 'mandate' },
        },
      ],
    })
    const first = pauseControls(parent, 'parent-first-pause')
    const second = pauseControls(parent, 'parent-second-pause')
    const parentPending = history([parent, first.requested, first.confirmed, first.resumed, second.requested], PARENT)
    const pendingHistories = [history([child]), history([binding(child, pr)], pr), parentPending]
    for (const use of ['review', 'correction'] as const)
      expect(
        resolveBoundWork({
          use,
          explicitSelection: true,
          pullRequest: pr,
          histories: pendingHistories,
          causal: await nativeCausal(pendingHistories, parentNodes),
          native: { branch: 'feature/bounded', base: 'main' },
        }),
      ).toMatchObject({ status: 'refused' })
    const wrongChildResume = must(
      parseRecord({
        version: 1,
        repository: PARENT.repository,
        target: PARENT.target,
        recordId: 'parent-second-resume-for-child',
        runId: 'run-parent-pause-matrix',
        operationId: 'op-parent-second-resume-for-child',
        kind: 'operator-control',
        inputs: [parent.recordId, second.confirmed.recordId],
        payload: {
          control: 'resume',
          controlId: 'parent-second-pause',
          predecessor: { scope: PARENT, recordId: second.confirmed.recordId, kind: 'operator-control' },
          mandate: { scope: SCOPE, recordId: child.recordId, kind: 'mandate' },
        },
      }),
    )
    const parentPaused = history(
      [parent, first.requested, first.confirmed, first.resumed, second.requested, second.confirmed, wrongChildResume],
      PARENT,
    )
    const pausedHistories = [history([child]), history([binding(child, pr)], pr), parentPaused]
    expect(
      resolveBoundWork({
        use: 'review',
        explicitSelection: true,
        pullRequest: pr,
        histories: pausedHistories,
        causal: await nativeCausal(pausedHistories, parentNodes),
        native: { branch: 'feature/bounded', base: 'main' },
      }),
    ).toMatchObject({ status: 'refused' })
  })
})
