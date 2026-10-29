import { describe, expect, test } from 'vitest'
import { observedComment } from '../../testing/record-history.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import type { DecodedHistory } from '../history-schema.ts'
import { parseRecord } from '../record-construction.ts'
import type { Scope } from '../record-values.ts'
import { resolveBoundWork } from '../workflow-bound-work-resolution.ts'
import type { MandateRecord } from '../workflow-control.ts'
import { assessFixMandate } from '../workflow-correction-admission.ts'
import { requireLandingMandate } from '../workflow-landing-admission.ts'
import { selectWorkflowBinding } from '../workflow-pr-binding.ts'
import { reconstructWorkflow } from '../workflow-reconstruction-admission.ts'
import type { SpecializedDecisions, WorkflowFacts } from '../workflow-reconstruction-types.ts'
import {
  BODY,
  binding,
  facts,
  featureMandate,
  history,
  mandate,
  must,
  PARENT,
  pauseControls,
  SCOPE,
} from './workflow-test-support.ts'

const landingFixtures = roxabiWorkflowFixtures()

function withConfirmedIdentities(histories: readonly DecodedHistory[]): DecodedHistory[] {
  return histories.map((entry) => {
    const present = new Set(
      entry.operations.flatMap((operation) =>
        operation.record?.kind === 'spec-identity'
          ? [`${operation.record.repository}\0${operation.record.target}\0${operation.record.recordId}`]
          : [],
      ),
    )
    const allocations: DecodedHistory['operations'] = []
    for (const operation of entry.operations) {
      if (operation.record?.kind !== 'mandate') continue
      for (const ref of operation.record.payload.ownSpec.identityAllocations) {
        const key = `${ref.scope.repository}\0${ref.scope.target}\0${ref.recordId}`
        if (present.has(key)) continue
        const record = landingFixtures.identityAllocation(ref.scope, ref.recordId)
        allocations.push({
          operationId: record.operationId,
          recordId: record.recordId,
          kind: record.kind,
          status: 'complete',
          authority: 'accounted',
          claimedKinds: [record.kind],
          parts: [observedComment({ locator: `comment-${record.recordId}`, nativeId: record.recordId })],
          record,
        })
        present.add(key)
      }
    }
    return allocations.length === 0 ? entry : { ...entry, operations: [...allocations, ...entry.operations] }
  })
}

function landingInput(
  mandate: MandateRecord,
  histories: readonly DecodedHistory[],
  pullRequest: Scope,
  parentScopes: readonly Scope[] = [],
) {
  const ownSpec = mandate.payload.ownSpec
  const config = mandate.payload.config
  return {
    histories: withConfirmedIdentities(histories),
    native: { branch: 'feature/bounded', base: 'main', pullRequest, linkedIssueScopes: [SCOPE] },
    parentScopes,
    uwGraph: {
      status: 'complete' as const,
      root: ownSpec.uw,
      nodes: [
        {
          uw: ownSpec.uw,
          title: 'Fixture UW',
          raw: ownSpec.snapshot.raw,
          updatedAt: ownSpec.snapshot.raw.lastEditedAt ?? '2026-10-27T12:00:00Z',
          labels: ['size:S'],
          wayfinderLabels: [],
          parent: null,
          children: [],
          blockers: [],
          native: { state: 'OPEN' as const, stateReason: null },
        },
      ],
      observedAt: ownSpec.snapshot.raw.lastEditedAt ?? '2026-10-27T12:00:00Z',
    },
    current: {
      productVersion: config.productVersion,
      configVersion: config.version,
      configDigest: config.digest,
      supportedConfigVersions: [config.version],
      proposedSpec: { ok: true as const, snapshot: ownSpec.snapshot },
      currentChildren: { ok: true as const, value: [] },
    },
    localInhibit: null,
  }
}

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
      },
    })
    expect(decision).toMatchObject({
      status: 'blocked',
      reason: 'session-cwd',
      evidence: [expect.objectContaining({ detail: { path: '/work', instruction: '/move /work' } })],
    })
  })
  test('lands a standalone feature through one binding and refuses absence, conflict, and an omitted epic parent', () => {
    const feature = featureMandate()
    expect(requireLandingMandate(landingInput(feature, [history([feature, binding(feature)])], SCOPE))).toMatchObject({
      ok: true,
      recordId: feature.recordId,
    })
    expect(requireLandingMandate(landingInput(feature, [history([feature])], SCOPE))).toMatchObject({
      ok: false,
      reason: 'missing',
    })
    const other = must(parseRecord({ ...feature, recordId: 'mandate-2', operationId: 'op-mandate-2' }))
    expect(
      selectWorkflowBinding({
        pullRequest: SCOPE,
        histories: [history([feature, other, binding(feature), binding(other)])],
        native: { branch: 'feature/bounded', base: 'main' },
      }).status,
    ).toBe('conflicting')
    const epic = landingFixtures.epicMandate(PARENT, [landingFixtures.childSnapshot(SCOPE, BODY)], {
      recordId: 'epic-1',
      runId: 'abcd1234',
      operationId: 'op-epic',
      body: BODY,
    })
    expect(
      requireLandingMandate(
        landingInput(feature, [history([feature, binding(feature)]), history([epic], PARENT)], SCOPE),
      ),
    ).toMatchObject({ ok: false, reason: 'missing' })
    const parent = landingFixtures.featureMandate(PARENT, {
      recordId: 'parent-mandate',
      runId: 'run-1',
      operationId: 'op-parent',
      branch: 'feature/bounded',
      base: 'main',
      lineageHead: null,
      body: BODY,
    })
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
    if (child.kind !== 'mandate') throw new Error('fixture is not a mandate')
    expect(
      requireLandingMandate(
        landingInput(
          child,
          [history([child, binding(child)]), history([parent, requested, confirmed], PARENT)],
          SCOPE,
          [PARENT],
        ),
      ),
    ).toMatchObject({ ok: false, reason: 'paused' })
    expect(
      assessFixMandate({
        target: { scope: SCOPE, kind: 'pull-request', branch: 'feature/bounded', base: 'main' },
        linkedIssueScopes: [],
        history: history([mandate()]),
        linkedIssueHistory: null,
      }),
    ).toMatchObject({
      status: 'refused',
      reason: 'unknown-binding',
      evidence: [expect.objectContaining({ code: 'fix-own-uw-required' })],
    })
    expect(
      assessFixMandate({
        target: { scope: SCOPE, kind: 'pull-request', branch: 'feature/bounded', base: 'main' },
        linkedIssueScopes: [],
        history: history([]),
        linkedIssueHistory: null,
      }),
    ).toMatchObject({ status: 'refused', reason: 'unknown-binding' })
    expect(
      assessFixMandate({
        target: { scope: SCOPE, kind: 'pull-request', branch: 'feature/bounded', base: 'main' },
        linkedIssueScopes: [SCOPE],
        history: history([feature]),
        linkedIssueHistory: null,
      }),
    ).toMatchObject({ status: 'refused', reason: 'unknown-binding' })
  })
  test('refuses unconfirmed own pauses and preserves successor pause controls', () => {
    const pr: Scope = { repository: 'acme/app', target: 'acme/app#99' }
    const feature = featureMandate()
    const native = { branch: 'feature/bounded', base: 'main' }
    const decisions: SpecializedDecisions = {
      reviewStep: null,
      epicStep: null,
      epicLand: null,
      ciWatchStatus: null,
      publish: { status: 'absent', evidence: [] },
      landing: { status: 'absent', evidence: [] },
      watch: { status: 'absent', evidence: [] },
    }
    const bound = (histories: DecodedHistory[], use: 'review' | 'correction') =>
      resolveBoundWork({ use, explicitSelection: true, pullRequest: pr, histories, native })
    const landing = (histories: DecodedHistory[], parentScopes: Scope[] = [], mandate: MandateRecord = feature) =>
      requireLandingMandate(landingInput(mandate, histories, pr, parentScopes))
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
        target: { scope: pr, kind: 'pull-request', branch: 'feature/bounded', base: 'main' },
        linkedIssueScopes: [SCOPE],
        history: history([binding(standaloneFix, pr)], pr),
        linkedIssueHistory: history([standaloneFix, standalonePause.requested]),
      }),
    ).toMatchObject({ status: 'refused', reason: 'unconfirmed' })
  })

  test('keeps parent pause cycles active for a child with a current accepted grant', () => {
    const pr: Scope = { repository: 'acme/app', target: 'acme/app#99' }
    const childGrant = landingFixtures.childSnapshot(SCOPE, BODY)
    const parent = landingFixtures.epicMandate(PARENT, [childGrant], {
      recordId: 'parent-pause-matrix',
      runId: 'run-parent-pause-matrix',
      operationId: 'op-parent-pause-matrix',
      body: BODY,
    })
    const child = landingFixtures.featureMandate(SCOPE, {
      recordId: 'child-pause-matrix',
      runId: 'run-child-pause-matrix',
      operationId: 'op-child-pause-matrix',
      branch: 'feature/bounded',
      base: 'main',
      lineageHead: null,
      body: BODY,
      ownSpec: landingFixtures.ownSpecFromSnapshot(SCOPE, childGrant.snapshot),
      tier: childGrant.tier,
      parent: { scope: PARENT, recordId: parent.recordId, kind: 'mandate' },
    })
    const decisions: SpecializedDecisions = {
      reviewStep: null,
      epicStep: null,
      epicLand: null,
      ciWatchStatus: null,
      publish: { status: 'absent', evidence: [] },
      landing: { status: 'absent', evidence: [] },
      watch: { status: 'absent', evidence: [] },
    }
    const childFacts = facts({
      productVersion: child.payload.config.productVersion,
      configVersion: child.payload.config.version,
      configDigest: child.payload.config.digest,
      supportedConfigVersions: [child.payload.config.version],
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
          native: { branch: 'feature/bounded', base: 'main' },
        }),
      ).toMatchObject({ status: 'refused' })
    expect(requireLandingMandate(landingInput(child, pendingHistories, pr, [PARENT]))).toMatchObject({ ok: false })
    expect(
      reconstructWorkflow({
        evidence: { issue: history([child]), pullRequest: null, parents: [parentPending] },
        facts: childFacts,
        decisions,
      }),
    ).not.toMatchObject({ status: 'action' })

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
        native: { branch: 'feature/bounded', base: 'main' },
      }),
    ).toMatchObject({ status: 'refused' })
    expect(requireLandingMandate(landingInput(child, pausedHistories, pr, [PARENT]))).toMatchObject({ ok: false })
    expect(
      reconstructWorkflow({
        evidence: { issue: history([child]), pullRequest: null, parents: [parentPaused] },
        facts: { ...childFacts, explicitResume: true },
        decisions,
      }),
    ).not.toMatchObject({ status: 'action' })
  })
})
