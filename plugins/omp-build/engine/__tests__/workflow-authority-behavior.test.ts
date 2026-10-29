import { describe, expect, test } from 'vitest'
import { observedComment } from '../../testing/record-history.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { classifyHistory } from '../history-classification.ts'
import type { DecodedHistory } from '../history-schema.ts'
import { buildRecord, parseRecord } from '../record-construction.ts'
import { specDigest } from '../record-digests.ts'
import { projectRecord } from '../record-projection.ts'
import type { Scope } from '../record-values.ts'
import { resolveAcceptedSpec } from '../workflow-accepted-spec.ts'
import type { MandateRecord } from '../workflow-control.ts'
import { assessFixMandate } from '../workflow-correction-admission.ts'
import { requireLandingMandate } from '../workflow-landing-admission.ts'
import { effectiveMandateRole } from '../workflow-mandate.ts'
import { resolveOwnSpecAuthority, selectApplicableMandate } from '../workflow-mandate-admission.ts'
import { reconstructWorkflow } from '../workflow-reconstruction-admission.ts'
import {
  acceptedMaterialState,
  acceptMaterialFixture,
  assessFixture,
  mandateAssessmentState,
  proposedAssessmentState,
} from './workflow-spec-assessment-support.ts'
import { BODY, binding, facts, history, mandate, must, PARENT, SCOPE } from './workflow-test-support.ts'

const landingFixtures = roxabiWorkflowFixtures()

function featureMandate(): MandateRecord {
  return landingFixtures.featureMandate(SCOPE, {
    recordId: 'mandate-1',
    runId: 'run-1',
    operationId: 'op-mandate-1',
    branch: 'feature/bounded',
    base: 'main',
    lineageHead: null,
    body: BODY,
  })
}

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

describe('workflow authority behavior', () => {
  test('projects an accounted mandate without granting review authority or reading a broken review', () => {
    const record = featureMandate()
    const broken = history([record])
    broken.operations.push({
      operationId: 'op-broken-review',
      recordId: 'review-missing',
      kind: 'review',
      status: 'incomplete',
      authority: 'authority',
      claimedKinds: ['review'],
      parts: [],
      record: null,
    })
    expect(classifyHistory(broken).classes.find((entry) => entry.operationId === record.operationId)?.authority).toBe(
      'accounted',
    )
    expect(projectRecord(record, broken, null)).toMatchObject({ ok: true })
    expect(projectRecord(record, broken, null, []).ok).toBe(true)
  })
  test('refuses a fix-only mandate at landing and does not treat pause as stop', () => {
    const record = mandate()
    const landing = requireLandingMandate(landingInput(record, [history([record, binding(record)])], SCOPE))
    expect(landing).toMatchObject({ ok: false, reason: 'fix-only' })
    const requested = must(
      parseRecord({
        version: 1,
        repository: SCOPE.repository,
        target: SCOPE.target,
        recordId: 'pause-requested',
        runId: 'run-1',
        operationId: 'op-pause-requested',
        kind: 'operator-control',
        inputs: [record.recordId],
        payload: {
          control: 'pause-requested',
          controlId: 'control-1',
          predecessor: null,
          mandate: { scope: SCOPE, recordId: record.recordId, kind: 'mandate' },
        },
      }),
    )
    const confirmed = must(
      parseRecord({
        version: 1,
        repository: SCOPE.repository,
        target: SCOPE.target,
        recordId: 'pause-confirmed',
        runId: 'run-1',
        operationId: 'op-pause-confirmed',
        kind: 'operator-control',
        inputs: [record.recordId, requested.recordId],
        payload: {
          control: 'pause-confirmed',
          controlId: 'control-1',
          predecessor: { scope: SCOPE, recordId: requested.recordId, kind: 'operator-control' },
          disarm: { observed: true, evidence: { source: 'host' } },
          mandate: { scope: SCOPE, recordId: record.recordId, kind: 'mandate' },
        },
      }),
    )
    const decision = reconstructWorkflow({
      evidence: { issue: history([record, requested, confirmed]), pullRequest: null, parents: [] },
      facts: facts(),
      decisions: {
        reviewStep: 'stop',
        epicStep: null,
        epicLand: null,
        ciWatchStatus: null,
        publish: { status: 'absent', evidence: [] },
        landing: { status: 'absent', evidence: [] },
        watch: { status: 'absent', evidence: [] },
      },
    })
    expect(decision.status).toBe('paused')
    expect(decision).not.toMatchObject({ status: 'terminal', reason: 'bound-stop' })
  })
  test('refuses abandoned and revoked mandates instead of reporting them missing', () => {
    const record = featureMandate()
    const abandoned = must(
      parseRecord({
        version: 1,
        repository: SCOPE.repository,
        target: SCOPE.target,
        recordId: 'abandon-1',
        runId: 'run-1',
        operationId: 'op-abandon',
        kind: 'operator-control',
        inputs: [record.recordId],
        payload: {
          control: 'abandon',
          controlId: 'control-abandon',
          predecessor: null,
          mandate: { scope: SCOPE, recordId: record.recordId, kind: 'mandate' },
        },
      }),
    )
    expect(selectApplicableMandate(history([record, abandoned]))).toMatchObject({
      status: 'refused',
      reason: 'abandoned',
    })
    expect(
      assessFixMandate({
        target: { scope: SCOPE, kind: 'issue', branch: 'feature/bounded', base: 'main' },
        linkedIssueScopes: [SCOPE],
        history: history([record, abandoned]),
        linkedIssueHistory: null,
      }),
    ).toMatchObject({ status: 'refused', reason: 'abandoned' })
    const missing = selectApplicableMandate(history([]))
    expect(missing.status === 'refused' && missing.reason).toBe('missing')
  })
  test('does not borrow child authority from a revoked epic parent through its successor', () => {
    const child = featureMandate()
    const parentOne = landingFixtures.epicMandate(PARENT, [landingFixtures.childSnapshot(SCOPE, BODY)], {
      recordId: 'epic-parent-one',
      runId: 'run00001',
      operationId: 'op-epic-parent-one',
      body: BODY,
    })
    const parentOneRef = landingFixtures.mandateRef(parentOne)
    const parentTwo = landingFixtures.epicMandate(PARENT, [], {
      recordId: 'epic-parent-two',
      runId: 'run00002',
      operationId: 'op-epic-parent-two',
      body: BODY,
      antecedent: parentOneRef,
    })
    const revokedParent = must(
      buildRecord({
        version: 1,
        repository: PARENT.repository,
        target: PARENT.target,
        recordId: 'abandon-epic-parent-one',
        runId: 'run00001',
        operationId: 'op-abandon-epic-parent-one',
        kind: 'operator-control',
        payload: { control: 'abandon', controlId: 'abandon-epic-parent-one', mandate: parentOneRef, predecessor: null },
      }),
    )
    const selectedParent = must(
      buildRecord({
        version: 1,
        repository: PARENT.repository,
        target: PARENT.target,
        recordId: 'select-epic-parent-two',
        runId: 'run00002',
        operationId: 'op-select-epic-parent-two',
        kind: 'operator-control',
        payload: {
          control: 'select-successor',
          controlId: 'select-epic-parent-two',
          mandate: { scope: PARENT, recordId: parentTwo.recordId, kind: 'mandate' },
          predecessor: parentOneRef,
          successor: { scope: PARENT, recordId: parentTwo.recordId, kind: 'mandate' },
        },
      }),
    )
    const boundChild = must(parseRecord({ ...child, payload: { ...child.payload, parent: parentOneRef } }))
    if (boundChild.kind !== 'mandate') throw new Error('fixture is not a mandate')
    const parentHistory = history([parentOne, revokedParent, parentTwo, selectedParent], PARENT)
    const childHistory = history([boundChild])
    expect(selectApplicableMandate(childHistory, [parentHistory])).toMatchObject({
      status: 'refused',
      reason: 'revoked',
    })
    expect(resolveOwnSpecAuthority(childHistory, [parentHistory])).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'revoked' })],
    })
    expect(
      reconstructWorkflow({
        evidence: { issue: childHistory, pullRequest: null, parents: [parentHistory] },
        facts: facts(),
        decisions: {
          reviewStep: null,
          epicStep: null,
          epicLand: null,
          ciWatchStatus: null,
          publish: { status: 'absent', evidence: [] },
          landing: { status: 'absent', evidence: [] },
          watch: { status: 'absent', evidence: [] },
        },
      }),
    ).not.toMatchObject({ status: 'action' })
    expect(
      assessFixMandate({
        target: { scope: SCOPE, kind: 'issue', branch: 'feature/bounded', base: 'main' },
        linkedIssueScopes: [SCOPE],
        history: childHistory,
        linkedIssueHistory: null,
        externalHistories: [parentHistory],
      }),
    ).not.toMatchObject({ status: 'applicable' })
    const pull: Scope = { repository: SCOPE.repository, target: 'acme/app#99' }
    expect(
      requireLandingMandate(
        landingInput(boundChild, [childHistory, history([binding(boundChild, pull)], pull), parentHistory], pull, [
          PARENT,
        ]),
      ),
    ).toMatchObject({ ok: false })
  })
  test('permits Spec control through a mismatched parent commitment while delivery refuses the mismatch', () => {
    const child = featureMandate()
    const parent = landingFixtures.epicMandate(PARENT, [landingFixtures.childSnapshot(SCOPE, 'parent C2')], {
      recordId: 'parent-mandate',
      runId: 'parent01',
      operationId: 'op-parent',
      body: BODY,
    })
    const childWithParent = must(
      parseRecord({
        ...child,
        payload: {
          ...child.payload,
          parent: landingFixtures.mandateRef(parent),
        },
      }),
    )
    if (childWithParent.kind !== 'mandate') throw new Error('fixture is not a mandate')
    const childHistory = history([childWithParent])
    const parentHistory = history([parent], PARENT)

    expect(resolveOwnSpecAuthority(childHistory, [parentHistory])).toMatchObject({
      ok: true,
      value: {
        mandate: { recordId: childWithParent.recordId },
        accepted: { ref: { version: child.payload.ownSpec.version } },
      },
    })
    expect(selectApplicableMandate(childHistory, [parentHistory])).toMatchObject({
      status: 'refused',
      reason: 'materially-changed',
    })
  })
  test('does not treat presentation-only raw child differences as parent commitment drift', () => {
    const child = featureMandate()
    const childRaw = {
      ...child.payload.ownSpec.snapshot.raw,
      body: `\n${BODY}\n`,
      bodySha256: specDigest(`\n${BODY}\n`),
    }
    const childWithPresentation = must(
      parseRecord({
        ...child,
        payload: {
          ...child.payload,
          ownSpec: {
            ...child.payload.ownSpec,
            snapshot: { ...child.payload.ownSpec.snapshot, raw: childRaw },
          },
        },
      }),
    )
    if (childWithPresentation.kind !== 'mandate') throw new Error('fixture is not a mandate')
    const parentBase = landingFixtures.epicMandate(PARENT, [landingFixtures.childSnapshot(SCOPE, BODY)], {
      recordId: 'parent-presentation',
      runId: 'parent02',
      operationId: 'op-parent-presentation',
      body: BODY,
    })
    const parentCommitment = parentBase.payload.children[0]
    if (parentCommitment === undefined) throw new Error('fixture parent has no child commitment')
    const parent = must(
      parseRecord({
        ...parentBase,
        payload: {
          ...parentBase.payload,
          children: [
            {
              ...parentCommitment,
              snapshot: {
                ...child.payload.ownSpec.snapshot,
                raw: { ...child.payload.ownSpec.snapshot.raw, lastEditedAt: '2026-10-22T00:00:00Z' },
              },
            },
          ],
        },
      }),
    )
    if (parent.kind !== 'mandate') throw new Error('fixture is not a mandate')
    const boundChild = must(
      parseRecord({
        ...childWithPresentation,
        payload: { ...childWithPresentation.payload, parent: landingFixtures.mandateRef(parent) },
      }),
    )
    if (boundChild.kind !== 'mandate') throw new Error('fixture is not a mandate')

    expect(selectApplicableMandate(history([boundChild]), [history([parent], PARENT)])).toMatchObject({
      status: 'applicable',
      mandate: { recordId: boundChild.recordId },
    })
  })
  test('refuses own Spec control through incomplete parents and permission excess', () => {
    const child = featureMandate()
    const parentBase = landingFixtures.epicMandate(PARENT, [landingFixtures.childSnapshot(SCOPE, BODY)], {
      recordId: 'restricted-parent',
      runId: 'parent03',
      operationId: 'op-restricted-parent',
      body: BODY,
    })
    const parent = must(
      parseRecord({
        ...parentBase,
        payload: { ...parentBase.payload, permissions: { landing: false, correct: true } },
      }),
    )
    if (parent.kind !== 'mandate') throw new Error('fixture is not a mandate')
    const childWithParent = must(
      parseRecord({
        ...child,
        payload: { ...child.payload, parent: landingFixtures.mandateRef(parent) },
      }),
    )
    const childHistory = history([childWithParent])
    const parentHistory = history([parent], PARENT)
    expect(resolveOwnSpecAuthority(childHistory, [parentHistory])).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'incompatible' })],
    })
    expect(
      resolveOwnSpecAuthority(childHistory, [
        { ...parentHistory, source: { ...parentHistory.source, complete: false } },
      ]),
    ).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'incomplete' })],
    })
  })
  test('refuses own Spec control through an ambiguous parent mandate history', () => {
    const child = featureMandate()
    const first = landingFixtures.epicMandate(PARENT, [landingFixtures.childSnapshot(SCOPE, BODY)], {
      recordId: 'ambiguous-parent-a',
      runId: 'parent04',
      operationId: 'op-parent-a',
      body: BODY,
    })
    const second = landingFixtures.epicMandate(PARENT, [landingFixtures.childSnapshot(SCOPE, BODY)], {
      recordId: 'ambiguous-parent-b',
      runId: 'parent05',
      operationId: 'op-parent-b',
      body: BODY,
    })
    const childWithParent = must(
      parseRecord({
        ...child,
        payload: { ...child.payload, parent: landingFixtures.mandateRef(first) },
      }),
    )

    expect(resolveOwnSpecAuthority(history([childWithParent]), [history([first, second], PARENT)])).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'ambiguous' })],
    })
  })
  test('derives feature-origin parent commitments from the latest material acceptance', () => {
    const child = landingFixtures.featureMandate(PARENT, {
      recordId: 'child-mandate',
      runId: 'run-child',
      operationId: 'op-child',
      branch: 'feature/bounded',
      base: 'main',
      lineageHead: null,
      body: BODY,
    })
    const parent = landingFixtures.featureMandate(SCOPE, {
      recordId: 'parent-material',
      runId: 'run-parent',
      operationId: 'op-parent',
      branch: 'feature/parent',
      base: 'main',
      lineageHead: null,
      body: BODY,
    })
    const initial = mandateAssessmentState(parent)
    const changed = assessFixture(
      parent,
      'parent-child-change',
      initial,
      proposedAssessmentState(initial, {
        body: BODY,
        children: [{ ...landingFixtures.childSnapshot(PARENT, 'child C2'), tier: 'F-lite' }],
      }),
      'material',
    )
    const acceptedChange = acceptMaterialFixture(parent, 'accept-parent-child-change', changed)
    const afterChange = acceptedMaterialState(changed, acceptedChange)
    const removed = assessFixture(
      parent,
      'parent-child-removal',
      afterChange,
      proposedAssessmentState(afterChange, { body: BODY, children: [] }),
      'material',
    )
    const acceptedRemoval = acceptMaterialFixture(parent, 'accept-parent-child-removal', removed, afterChange)
    const childWithParent = must(
      parseRecord({
        ...child,
        payload: { ...child.payload, parent: landingFixtures.mandateRef(parent) },
      }),
    )
    if (childWithParent.kind !== 'mandate') throw new Error('fixture is not a mandate')
    const childHistory = history([childWithParent], PARENT)
    const changedParentHistory = history([parent, changed.start, changed.result, acceptedChange], SCOPE)
    const acceptedParent = resolveAcceptedSpec(parent, [changedParentHistory])
    if (!acceptedParent.ok) throw new Error('changed parent Spec was not accepted')
    expect(effectiveMandateRole(parent.payload.role, acceptedParent.spec)).toBe('epic')
    expect(selectApplicableMandate(childHistory, [changedParentHistory])).toMatchObject({
      status: 'refused',
      reason: 'materially-changed',
    })
    const childInitial = mandateAssessmentState(childWithParent)
    const childC2 = proposedAssessmentState(childInitial, { body: 'child C2', tier: 'F-lite' })
    const controlFacts = facts({
      productVersion: childWithParent.payload.config.productVersion,
      configVersion: childWithParent.payload.config.version,
      configDigest: childWithParent.payload.config.digest,
      supportedConfigVersions: [childWithParent.payload.config.version],
      currentSpec: childC2,
      identityAllocations: childWithParent.payload.ownSpec.identityAllocations,
    })
    const controlDecisions = {
      reviewStep: null,
      epicStep: 'start' as const,
      epicLand: null,
      ciWatchStatus: null,
      publish: { status: 'absent' as const, evidence: [] },
      landing: { status: 'absent' as const, evidence: [] },
      watch: { status: 'absent' as const, evidence: [] },
    }
    expect(
      reconstructWorkflow({
        evidence: { issue: childHistory, pullRequest: null, parents: [changedParentHistory] },
        facts: controlFacts,
        decisions: controlDecisions,
      }),
    ).toMatchObject({ status: 'action', action: 'assess-spec', mandateId: childWithParent.recordId })
    const childAssessment = assessFixture(childWithParent, 'child-c2-assessment', childInitial, childC2, 'material')
    const assessedChildHistory = history([childWithParent, childAssessment.start, childAssessment.result], PARENT)
    expect(
      reconstructWorkflow({
        evidence: { issue: assessedChildHistory, pullRequest: null, parents: [changedParentHistory] },
        facts: controlFacts,
        decisions: controlDecisions,
      }),
    ).toMatchObject({ status: 'blocked', reason: 'spec-decision-required' })
    const acceptedChild = acceptMaterialFixture(childWithParent, 'accept-child-c2', childAssessment)
    expect(
      selectApplicableMandate(
        history([childWithParent, childAssessment.start, childAssessment.result, acceptedChild], PARENT),
        [changedParentHistory],
      ),
    ).toMatchObject({ status: 'applicable', mandate: { recordId: childWithParent.recordId } })
    const parentHistory = history(
      [parent, changed.start, changed.result, acceptedChange, removed.start, removed.result, acceptedRemoval],
      SCOPE,
    )

    const removedParent = resolveAcceptedSpec(parent, [parentHistory])
    if (!removedParent.ok) throw new Error('removed parent Spec was not accepted')
    expect(effectiveMandateRole(parent.payload.role, removedParent.spec)).toBe('feature')
    expect(resolveOwnSpecAuthority(childHistory, [parentHistory])).toMatchObject({ ok: true })
    expect(selectApplicableMandate(childHistory, [parentHistory])).toMatchObject({
      status: 'refused',
      reason: 'unknown-binding',
    })
  })
})
