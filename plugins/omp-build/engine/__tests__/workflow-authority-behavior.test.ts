import { describe, expect, test } from 'vitest'
import { classifyHistory } from '../history-classification.ts'
import { buildRecord, parseRecord } from '../record-construction.ts'
import { specDigest } from '../record-digests.ts'
import { projectRecord } from '../record-projection.ts'
import type { Scope } from '../record-values.ts'
import { assessFixMandate } from '../workflow-correction-admission.ts'
import { requireLandingMandate } from '../workflow-landing-admission.ts'
import { selectApplicableMandate } from '../workflow-mandate-admission.ts'
import { reconstructWorkflow } from '../workflow-reconstruction-admission.ts'
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
  SCOPE,
} from './workflow-test-support.ts'

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
    const landing = requireLandingMandate({
      histories: [history([record, binding(record)])],
      native: { branch: 'feature/bounded', base: 'main', pullRequest: SCOPE, linkedIssueScopes: [SCOPE] },
      parentScopes: [],
      current: {
        productVersion: '0.11.0',
        configVersion: 'catalogue-1',
        configDigest: DIGEST,
        supportedConfigVersions: ['catalogue-1'],
        specDigest: specDigest(BODY),
        specBody: BODY,
      },
      localInhibit: null,
    })
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
    const parentOne = must(
      buildRecord({
        version: 1,
        repository: PARENT.repository,
        target: PARENT.target,
        recordId: 'epic-parent-one',
        runId: 'run00001',
        operationId: 'op-epic-parent-one',
        kind: 'mandate',
        payload: {
          role: 'epic',
          format: 'omp-build-mandate/2',
          run: 'run00001',
          children: [{ scope: SCOPE, specDigest: specDigest(BODY), specBody: BODY }],
          branch: null,
          base: 'main',
          lineageHead: null,
          config: child.payload.config,
          parent: null,
          antecedent: null,
          spec: {
            reference: PARENT.target,
            body: BODY,
            bodySha256: specDigest(BODY),
            lastEditedAt: '2026-10-21T00:00:00Z',
          },
          permissions: { landing: true, correct: true },
        },
      }),
    )
    const parentOneRef = { scope: PARENT, recordId: parentOne.recordId, kind: 'mandate' as const }
    const parentTwo = must(
      buildRecord({
        version: 1,
        repository: PARENT.repository,
        target: PARENT.target,
        recordId: 'epic-parent-two',
        runId: 'run00002',
        operationId: 'op-epic-parent-two',
        kind: 'mandate',
        payload: {
          role: 'epic',
          format: 'omp-build-mandate/2',
          run: 'run00002',
          children: [],
          branch: null,
          base: 'main',
          lineageHead: null,
          config: child.payload.config,
          parent: null,
          antecedent: parentOneRef,
          spec: {
            reference: PARENT.target,
            body: BODY,
            bodySha256: specDigest(BODY),
            lastEditedAt: '2026-10-21T00:00:00Z',
          },
          permissions: { landing: false, correct: false },
        },
      }),
    )
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
    const parentHistory = history([parentOne, revokedParent, parentTwo, selectedParent], PARENT)
    const childHistory = history([boundChild])
    expect(selectApplicableMandate(childHistory, [parentHistory])).toMatchObject({
      status: 'refused',
      reason: 'revoked',
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
      requireLandingMandate({
        histories: [childHistory, history([binding(boundChild, pull)], pull), parentHistory],
        native: { branch: 'feature/bounded', base: 'main', pullRequest: pull, linkedIssueScopes: [SCOPE] },
        parentScopes: [PARENT],
        current: {
          productVersion: '0.11.0',
          configVersion: 'catalogue-1',
          configDigest: DIGEST,
          supportedConfigVersions: ['catalogue-1'],
          specDigest: specDigest(BODY),
          specBody: BODY,
        },
        localInhibit: null,
      }),
    ).toMatchObject({ ok: false })
  })
})
