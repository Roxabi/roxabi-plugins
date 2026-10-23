import { describe, expect, test } from 'vitest'
import type { DecodedHistory } from '../history-schema.ts'
import { parseRecord } from '../record-construction.ts'
import { specDigest } from '../record-digests.ts'
import type { Scope } from '../record-values.ts'
import { resolveBoundWork } from '../workflow-bound-work-resolution.ts'
import { assessFixMandate } from '../workflow-correction-admission.ts'
import { requireLandingMandate } from '../workflow-landing-admission.ts'
import { selectWorkflowBinding } from '../workflow-pr-binding.ts'
import { reconstructWorkflow } from '../workflow-reconstruction-admission.ts'
import type { SpecializedDecisions, WorkflowFacts } from '../workflow-reconstruction-types.ts'
import {
  BODY,
  binding,
  DIGEST,
  facts,
  featureMandate,
  history,
  mandate,
  must,
  PARENT,
  pauseControls,
  SCOPE,
} from './workflow-test-support.ts'

describe('workflow transition behavior', () => {
  test('blocks the first mandate when the session is not in the prepared worktree', () => {
    const decision = reconstructWorkflow({
      evidence: { issue: history([]), pullRequest: null, parents: [] },
      facts: facts({ explicitSelection: true, sessionCwd: '/principal', preparedWorktree: '/work' }),
      decisions: {
        reviewStep: null,
        epicStep: null,
        epicLand: null,
        ciWatchStatus: null,
        publish: { status: 'absent', evidence: [] },
        landing: { status: 'absent', evidence: [] },
        watch: { status: 'absent', evidence: [] },
        proof: { admission: null, candidateGitSHA: null, input: null, applicability: 'required', evidence: [] },
      },
    })
    expect(decision).toMatchObject({
      status: 'blocked',
      reason: 'session-cwd',
      evidence: [expect.objectContaining({ detail: { path: '/work', instruction: '/move /work' } })],
    })
  })
  test('lands a standalone feature through one binding and refuses absence, conflict, and an omitted epic parent', () => {
    const current = {
      productVersion: '0.11.0',
      configVersion: 'catalogue-1',
      configDigest: DIGEST,
      supportedConfigVersions: ['catalogue-1'],
      proofPins: [],
      specDigest: specDigest(BODY),
      specBody: BODY,
    }
    const native = { branch: 'feature/bounded', base: 'main', pullRequest: SCOPE, linkedIssueScopes: [SCOPE] }
    const feature = featureMandate()
    expect(
      requireLandingMandate({
        histories: [history([feature, binding(feature)])],
        native,
        parentScopes: [],
        current,
        localInhibit: null,
      }),
    ).toMatchObject({ ok: true, recordId: feature.recordId })
    expect(
      requireLandingMandate({
        histories: [history([feature])],
        native,
        parentScopes: [],
        current,
        localInhibit: null,
      }),
    ).toMatchObject({ ok: false, reason: 'missing' })
    const other = must(parseRecord({ ...feature, recordId: 'mandate-2', operationId: 'op-mandate-2' }))
    expect(
      selectWorkflowBinding({
        pullRequest: SCOPE,
        histories: [history([feature, other, binding(feature), binding(other)])],
        native: { branch: 'feature/bounded', base: 'main' },
      }).status,
    ).toBe('conflicting')
    const epicBuilt = mandate({ recordId: 'epic-1' })
    const epic = must(
      parseRecord({
        ...epicBuilt,
        repository: PARENT.repository,
        target: PARENT.target,
        operationId: 'op-epic',
        payload: {
          ...epicBuilt.payload,
          role: 'epic',
          run: 'abcd1234',
          children: [{ scope: SCOPE, specDigest: specDigest(BODY), specBody: BODY }],
          permissions: { landing: true, correct: true },
        },
      }),
    )
    expect(
      requireLandingMandate({
        histories: [history([feature, binding(feature)]), history([epic], PARENT)],
        native,
        parentScopes: [],
        current,
        localInhibit: null,
      }),
    ).toMatchObject({ ok: false, reason: 'missing' })
    const parent = must(
      parseRecord({
        ...feature,
        repository: PARENT.repository,
        target: PARENT.target,
        recordId: 'parent-mandate',
        operationId: 'op-parent',
      }),
    )
    const requested = must(
      parseRecord({
        version: 1,
        repository: PARENT.repository,
        target: PARENT.target,
        recordId: 'parent-pause-requested',
        runId: 'run-1',
        operationId: 'op-parent-pause-requested',
        kind: 'operator-control',
        inputs: [parent.recordId],
        payload: {
          control: 'pause-requested',
          controlId: 'parent-control',
          predecessor: null,
          mandate: { scope: PARENT, recordId: parent.recordId, kind: 'mandate' },
        },
      }),
    )
    const confirmed = must(
      parseRecord({
        version: 1,
        repository: PARENT.repository,
        target: PARENT.target,
        recordId: 'parent-pause-confirmed',
        runId: 'run-1',
        operationId: 'op-parent-pause-confirmed',
        kind: 'operator-control',
        inputs: [parent.recordId, requested.recordId],
        payload: {
          control: 'pause-confirmed',
          controlId: 'parent-control',
          predecessor: { scope: PARENT, recordId: requested.recordId, kind: 'operator-control' },
          disarm: { observed: true, evidence: { source: 'host' } },
          mandate: { scope: PARENT, recordId: parent.recordId, kind: 'mandate' },
        },
      }),
    )
    const child = must(
      parseRecord({
        ...feature,
        recordId: 'child-mandate',
        operationId: 'op-child',
        payload: {
          ...feature.payload,
          parent: { scope: PARENT, recordId: parent.recordId, kind: 'mandate' },
        },
      }),
    )
    expect(
      requireLandingMandate({
        histories: [history([child, binding(child)]), history([parent, requested, confirmed], PARENT)],
        native,
        parentScopes: [PARENT],
        current,
        localInhibit: null,
      }),
    ).toMatchObject({ ok: false, reason: 'paused' })
    expect(
      assessFixMandate({
        target: { scope: SCOPE, kind: 'pull-request', branch: 'feature/bounded', base: 'main' },
        linkedIssueScopes: [],
        history: history([mandate()]),
        linkedIssueHistory: null,
      }),
    ).toMatchObject({ status: 'applicable', execution: { correct: true, landing: false } })
    expect(
      assessFixMandate({
        target: { scope: SCOPE, kind: 'pull-request', branch: 'feature/bounded', base: 'main' },
        linkedIssueScopes: [],
        history: history([]),
        linkedIssueHistory: null,
      }),
    ).toMatchObject({ status: 'refused', reason: 'missing' })
    expect(
      assessFixMandate({
        target: { scope: SCOPE, kind: 'pull-request', branch: 'feature/bounded', base: 'main' },
        linkedIssueScopes: [SCOPE],
        history: history([feature]),
        linkedIssueHistory: null,
      }),
    ).toMatchObject({ status: 'refused', reason: 'unknown-binding' })
    expect(
      reconstructWorkflow({
        evidence: { issue: history([feature]), pullRequest: null, parents: [] },
        facts: facts({ pullRequest: { scope: SCOPE, head: 'abc', base: 'main', associatedIssue: null } }),
        decisions: {
          reviewStep: null,
          epicStep: null,
          epicLand: null,
          ciWatchStatus: null,
          publish: { status: 'absent', evidence: [] },
          landing: { status: 'absent', evidence: [] },
          watch: { status: 'absent', evidence: [] },
          proof: { admission: null, candidateGitSHA: null, input: null, applicability: 'required', evidence: [] },
        },
      }),
    ).toMatchObject({ status: 'blocked', reason: 'unknown-binding' })
  })
  test('refuses admissions for unconfirmed pause requests across authority chains and pause cycles', () => {
    const pr: Scope = { repository: 'acme/app', target: 'acme/app#99' }
    const feature = featureMandate()
    const current = {
      productVersion: '0.11.0',
      configVersion: 'catalogue-1',
      configDigest: DIGEST,
      supportedConfigVersions: ['catalogue-1'],
      proofPins: [],
      specDigest: specDigest(BODY),
      specBody: BODY,
    }
    const native = { branch: 'feature/bounded', base: 'main' }
    const landingNative = { ...native, pullRequest: pr, linkedIssueScopes: [SCOPE] }
    const decisions: SpecializedDecisions = {
      reviewStep: null,
      epicStep: null,
      epicLand: null,
      ciWatchStatus: null,
      publish: { status: 'absent', evidence: [] },
      landing: { status: 'absent', evidence: [] },
      watch: { status: 'absent', evidence: [] },
      proof: { admission: null, candidateGitSHA: null, input: null, applicability: 'required', evidence: [] },
    }
    const bound = (histories: DecodedHistory[], use: 'review' | 'correction') =>
      resolveBoundWork({ use, explicitSelection: true, pullRequest: pr, histories, native })
    const landing = (histories: DecodedHistory[], parentScopes: Scope[] = []) =>
      requireLandingMandate({ histories, native: landingNative, parentScopes, current, localInhibit: null })
    const reconstruct = (
      issue: DecodedHistory,
      parents: DecodedHistory[] = [],
      overrides: Partial<WorkflowFacts> = {},
    ) => reconstructWorkflow({ evidence: { issue, pullRequest: null, parents }, facts: facts(overrides), decisions })

    const ownFirstPause = pauseControls(feature, 'feature-first-pause')
    const ownResumed = [
      history([feature, ownFirstPause.requested, ownFirstPause.confirmed, ownFirstPause.resumed]),
      history([binding(feature, pr)], pr),
    ]
    expect(bound(ownResumed, 'review')).toMatchObject({ status: 'applicable', mandate: { recordId: feature.recordId } })
    expect(landing(ownResumed)).toMatchObject({ ok: true, recordId: feature.recordId })
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
    expect(bound(ownPending, 'review')).toMatchObject({
      status: 'refused',
      reason: 'unconfirmed',
      evidence: [expect.objectContaining({ code: 'pause-unconfirmed' })],
    })
    expect(bound(ownPending, 'correction')).toMatchObject({ status: 'refused', reason: 'unconfirmed' })
    expect(landing(ownPending)).toMatchObject({
      ok: false,
      reason: 'unconfirmed',
      evidence: [expect.objectContaining({ code: 'pause-unconfirmed' })],
    })
    expect(
      reconstruct(
        history([
          feature,
          ownFirstPause.requested,
          ownFirstPause.confirmed,
          ownFirstPause.resumed,
          ownSecondPause.requested,
        ]),
      ),
    ).toMatchObject({ status: 'blocked', reason: 'pause-unconfirmed' })
    const ownConfirmedHistory = history([
      feature,
      ownFirstPause.requested,
      ownFirstPause.confirmed,
      ownFirstPause.resumed,
      ownSecondPause.requested,
      ownSecondPause.confirmed,
    ])
    const ownConfirmed = [ownConfirmedHistory, history([binding(feature, pr)], pr)]
    expect(bound(ownConfirmed, 'review')).toMatchObject({ status: 'refused', reason: 'paused' })
    expect(landing(ownConfirmed)).toMatchObject({ ok: false, reason: 'paused' })
    expect(reconstruct(ownConfirmedHistory, [], { explicitResume: true })).toMatchObject({
      status: 'action',
      action: 'resume',
      mandateId: feature.recordId,
      pause: {
        mandate: { scope: SCOPE, recordId: feature.recordId, kind: 'mandate' },
        confirmation: { scope: SCOPE, recordId: ownSecondPause.confirmed.recordId, kind: 'operator-control' },
      },
    })
    const antecedent = featureMandate()
    const antecedentPause = pauseControls(antecedent, 'antecedent-pause')
    const successor = must(
      parseRecord({
        ...antecedent,
        recordId: 'mandate-successor',
        operationId: 'op-mandate-successor',
        inputs: [antecedent.recordId],
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
          mandate: { scope: SCOPE, recordId: successor.recordId, kind: 'mandate' },
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
    expect(reconstruct(successorHistory, [], { explicitSelection: true })).toMatchObject({
      status: 'action',
      action: 'resume',
      mandateId: successor.recordId,
      pause: {
        mandate: { scope: SCOPE, recordId: successor.recordId, kind: 'mandate' },
        confirmation: { scope: SCOPE, recordId: successorPause.confirmed.recordId, kind: 'operator-control' },
      },
    })
    expect(reconstruct(successorHistory, [], { explicitResume: true })).toMatchObject({
      status: 'action',
      action: 'resume',
      mandateId: successor.recordId,
      pause: {
        mandate: { scope: SCOPE, recordId: successor.recordId, kind: 'mandate' },
        confirmation: { scope: SCOPE, recordId: successorPause.confirmed.recordId, kind: 'operator-control' },
      },
    })
    expect(bound([history([], pr)], 'review')).toEqual({ status: 'standalone', binding: 'absent' })

    const standaloneFix = mandate()
    const standalonePause = pauseControls(standaloneFix, 'standalone-fix-pause')
    expect(
      assessFixMandate({
        target: { scope: SCOPE, kind: 'pull-request', branch: 'feature/bounded', base: 'main' },
        linkedIssueScopes: [],
        history: history([standaloneFix, standalonePause.requested]),
        linkedIssueHistory: null,
      }),
    ).toMatchObject({ status: 'refused', reason: 'unconfirmed' })

    const parent = must(
      parseRecord({
        ...feature,
        repository: PARENT.repository,
        target: PARENT.target,
        recordId: 'parent-mandate',
        operationId: 'op-parent-mandate',
      }),
    )
    if (parent.kind !== 'mandate') throw new Error('fixture is not a mandate')
    const child = must(
      parseRecord({
        ...feature,
        recordId: 'child-mandate',
        operationId: 'op-child-mandate',
        payload: {
          ...feature.payload,
          parent: { scope: PARENT, recordId: parent.recordId, kind: 'mandate' },
        },
      }),
    )
    if (child.kind !== 'mandate') throw new Error('fixture is not a mandate')
    const parentFirstPause = pauseControls(parent, 'parent-first-pause')
    const parentSecondPause = pauseControls(parent, 'parent-second-pause')
    const parentPendingHistory = history(
      [
        parent,
        parentFirstPause.requested,
        parentFirstPause.confirmed,
        parentFirstPause.resumed,
        parentSecondPause.requested,
      ],
      PARENT,
    )
    const parentPending = [history([child]), history([binding(child, pr)], pr), parentPendingHistory]
    expect(bound(parentPending, 'review')).toMatchObject({ status: 'refused', reason: 'unconfirmed' })
    expect(bound(parentPending, 'correction')).toMatchObject({ status: 'refused', reason: 'unconfirmed' })
    expect(landing(parentPending, [PARENT])).toMatchObject({
      ok: false,
      reason: 'unconfirmed',
      evidence: [expect.objectContaining({ code: 'pause-unconfirmed' })],
    })
    expect(reconstruct(history([child]), [parentPendingHistory])).toMatchObject({
      status: 'blocked',
      reason: 'pause-unconfirmed',
    })
    expect(reconstruct(history([child]), [parentPendingHistory], { explicitResume: true })).toMatchObject({
      status: 'blocked',
      reason: 'pause-unconfirmed',
    })

    const wrongMandateResume = must(
      parseRecord({
        version: 1,
        repository: PARENT.repository,
        target: PARENT.target,
        recordId: 'parent-second-resume-for-child',
        runId: 'run-1',
        operationId: 'op-parent-second-resume-for-child',
        kind: 'operator-control',
        inputs: [parent.recordId, parentSecondPause.confirmed.recordId],
        payload: {
          control: 'resume',
          controlId: 'parent-second-pause',
          predecessor: { scope: PARENT, recordId: parentSecondPause.confirmed.recordId, kind: 'operator-control' },
          mandate: { scope: SCOPE, recordId: child.recordId, kind: 'mandate' },
        },
      }),
    )
    const parentConfirmedHistory = history(
      [
        parent,
        parentFirstPause.requested,
        parentFirstPause.confirmed,
        parentFirstPause.resumed,
        parentSecondPause.requested,
        parentSecondPause.confirmed,
        wrongMandateResume,
      ],
      PARENT,
    )
    const parentConfirmed = [history([child]), history([binding(child, pr)], pr), parentConfirmedHistory]
    expect(bound(parentConfirmed, 'review')).toMatchObject({ status: 'refused', reason: 'paused' })
    expect(landing(parentConfirmed, [PARENT])).toMatchObject({ ok: false, reason: 'paused' })
    expect(reconstruct(history([child]), [parentConfirmedHistory], { explicitResume: true })).toMatchObject({
      status: 'paused',
      mandateId: parent.recordId,
      pause: {
        mandate: { scope: PARENT, recordId: parent.recordId, kind: 'mandate' },
        confirmation: { scope: PARENT, recordId: parentSecondPause.confirmed.recordId, kind: 'operator-control' },
      },
    })
  })
})
