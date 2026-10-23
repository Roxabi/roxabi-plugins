import { describe, expect, test } from 'vitest'
import { shippedWorkflowGraph, WORKFLOW_CONFIG_VERSION } from '../../roxabi/workflow-config.ts'
import { buildRecord, classifyHistory, parseRecord, projectRecord, scopedRefsOf } from '../core.ts'
import {
  type CanonicalRecord,
  type DecodedHistory,
  planDigest,
  planOutputSchema,
  planReviewSchema,
  type Scope,
  specDigest,
} from '../schemas.ts'
import {
  assessFixMandate,
  buildFixOnlyMandate,
  failedCheckEvidenceDigest,
  type MandateRecord,
  planMacro,
  reconstructWorkflow,
  requireLandingMandate,
  resolveAcceptedSpec,
  resolveBoundWork,
  type SpecializedDecisions,
  selectApplicableMandate,
  selectWorkflowBinding,
  type WorkflowFacts,
  type WorkflowGraph,
} from '../workflow.ts'

const SCOPE: Scope = { repository: 'acme/app', target: 'acme/app#42' }
const PARENT: Scope = { repository: 'acme/app', target: 'acme/app#7' }
const DIGEST = 'a'.repeat(64)
const BODY = 'ship the bounded workflow'
const GRAPH: WorkflowGraph = {
  version: 1,
  productVersion: '0.11.0',
  configVersion: 'catalogue-1',
  edgeOrder: 'array',
  nodes: [
    { id: 'frame', action: 'frame' },
    { id: 'land', action: 'land' },
    { id: 'stop', action: 'stop' },
  ],
  edges: [{ from: 'frame', to: 'land', when: 'always' }],
  initial: 'land',
}

function must<T>(result: { ok: true; value: T } | { ok: false; diagnostics: { code: string }[] }): T {
  if (!result.ok) throw new Error(result.diagnostics.map((item) => item.code).join(','))
  return result.value
}

function mandate(role: 'feature' | 'fix-only', overrides: { parent?: CanonicalRecord | null; recordId?: string } = {}) {
  const parent = overrides.parent ?? null
  return must(
    buildFixOnlyMandate({
      scope: SCOPE,
      recordId: overrides.recordId ?? 'mandate-1',
      runId: 'run-1',
      operationId: 'op-mandate-1',
      branch: 'feature/bounded',
      base: 'main',
      lineageHead: null,
      productVersion: '0.11.0',
      work: { reference: 'acme/app#42', body: BODY, lastEditedAt: '2026-10-21T00:00:00Z' },
      config: {
        version: 'catalogue-1',
        digest: DIGEST,
        effective: { graph: role === 'fix-only' ? { ...GRAPH, initial: 'land' } : GRAPH },
      },
      proofPins: [],
      parent:
        parent === null
          ? null
          : {
              scope: { repository: parent.repository, target: parent.target },
              recordId: parent.recordId,
              kind: parent.kind,
            },
      antecedent: null,
    }),
  )
}

function featureMandate(): MandateRecord {
  const built = mandate('fix-only')
  const record = must(
    parseRecord({
      ...built,
      payload: {
        ...built.payload,
        role: 'feature',
        permissions: { landing: true, correct: true },
      },
    }),
  )
  if (record.kind !== 'mandate') throw new Error('fixture is not a mandate')
  return record
}

function history(records: CanonicalRecord[], scope = SCOPE): DecodedHistory {
  return {
    source: { scope, expectedAuthor: 'operator', stopAuthor: null, complete: true, comments: [], diagnostics: [] },
    operations: records.map((record) => ({
      operationId: record.operationId,
      recordId: record.recordId,
      kind: record.kind,
      status: 'complete',
      authority:
        record.kind === 'mandate' ||
        record.kind === 'operator-control' ||
        record.kind === 'action-receipt' ||
        record.kind === 'workflow-binding'
          ? 'accounted'
          : 'authority',
      claimedKinds: [record.kind],
      parts: [],
      record,
    })),
    diagnostics: [],
  }
}

function binding(target: CanonicalRecord, scope = SCOPE): CanonicalRecord {
  return must(
    buildRecord({
      version: 1,
      repository: scope.repository,
      target: scope.target,
      recordId: `binding-${target.recordId}`,
      runId: 'run-1',
      operationId: `op-binding-${target.recordId}`,
      kind: 'workflow-binding',
      payload: {
        branch: 'feature/bounded',
        base: 'main',
        mandate: {
          scope: { repository: target.repository, target: target.target },
          recordId: target.recordId,
          kind: 'mandate',
        },
      },
    }),
  )
}
function pauseControls(mandate: MandateRecord, controlId: string) {
  const scope = { repository: mandate.repository, target: mandate.target }
  const requested = must(
    parseRecord({
      version: 1,
      repository: scope.repository,
      target: scope.target,
      recordId: `${controlId}-requested`,
      runId: 'run-1',
      operationId: `${controlId}-request-operation`,
      kind: 'operator-control',
      inputs: [mandate.recordId],
      payload: {
        control: 'pause-requested',
        controlId,
        predecessor: null,
        mandate: { scope, recordId: mandate.recordId, kind: 'mandate' },
      },
    }),
  )
  const confirmed = must(
    parseRecord({
      version: 1,
      repository: scope.repository,
      target: scope.target,
      recordId: `${controlId}-confirmed`,
      runId: 'run-1',
      operationId: `${controlId}-confirm-operation`,
      kind: 'operator-control',
      inputs: [mandate.recordId, requested.recordId],
      payload: {
        control: 'pause-confirmed',
        controlId,
        predecessor: { scope, recordId: requested.recordId, kind: 'operator-control' },
        disarm: { observed: true, evidence: { source: 'host' } },
        mandate: { scope, recordId: mandate.recordId, kind: 'mandate' },
      },
    }),
  )
  const resumed = must(
    parseRecord({
      version: 1,
      repository: scope.repository,
      target: scope.target,
      recordId: `${controlId}-resumed`,
      runId: 'run-1',
      operationId: `${controlId}-resume-operation`,
      kind: 'operator-control',
      inputs: [mandate.recordId, confirmed.recordId],
      payload: {
        control: 'resume',
        controlId,
        predecessor: { scope, recordId: confirmed.recordId, kind: 'operator-control' },
        mandate: { scope, recordId: mandate.recordId, kind: 'mandate' },
      },
    }),
  )
  return { requested, confirmed, resumed }
}

function facts(overrides: Partial<WorkflowFacts> = {}): WorkflowFacts {
  return {
    specDigest: specDigest(BODY),
    specBody: BODY,
    branch: 'feature/bounded',
    base: 'main',
    candidateGitSHA: null,
    pullRequest: null,
    merged: false,
    sessionCwd: '/work',
    preparedWorktree: '/work',
    productVersion: '0.11.0',
    configVersion: 'catalogue-1',
    configDigest: DIGEST,
    supportedConfigVersions: ['catalogue-1'],
    proofPins: [],
    explicitSelection: false,
    explicitResume: false,
    successorAntecedent: null,
    endObligationsMet: false,
    localInhibit: null,
    ...overrides,
  }
}

function implementationStart(mandate: MandateRecord, actionId: string, planActionId: string) {
  return must(
    buildRecord({
      version: 1,
      repository: mandate.repository,
      target: mandate.target,
      recordId: `${actionId}-start`,
      runId: 'run-1',
      operationId: `op-${actionId}-start`,
      kind: 'action-receipt',
      payload: {
        phase: 'start',
        action: 'implement',
        actionId,
        mandate: {
          scope: { repository: mandate.repository, target: mandate.target },
          recordId: mandate.recordId,
          kind: 'mandate',
        },
        exactInputs: { mandateId: mandate.recordId, planActionId },
      },
    }),
  )
}

function implementationResult(
  mandate: MandateRecord,
  start: CanonicalRecord,
  actionId: string,
  planActionId: string,
  admitted: boolean,
) {
  const sha = 'a'.repeat(40)
  return must(
    buildRecord({
      version: 1,
      repository: mandate.repository,
      target: mandate.target,
      recordId: `${actionId}-result`,
      runId: 'run-1',
      operationId: `op-${actionId}-result`,
      kind: 'action-receipt',
      payload: {
        phase: 'result',
        action: 'implement',
        actionId,
        mandate: {
          scope: { repository: mandate.repository, target: mandate.target },
          recordId: mandate.recordId,
          kind: 'mandate',
        },
        start: {
          scope: { repository: start.repository, target: start.target },
          recordId: start.recordId,
          kind: 'action-receipt',
        },
        exactInputs: { mandateId: mandate.recordId, planActionId },
        native: admitted
          ? { completion: 'completed', strict: 'valid', raw: null }
          : { completion: 'incomplete', strict: 'invalid', raw: null },
        structured: admitted
          ? {
              outcome: 'implemented',
              commitSHAs: [sha],
              commands: [{ toolCallId: 'call-implement', command: 'bun test', exitCode: 0 }],
              proofToolCallId: 'call-proof',
              proofUnavailableReason: null,
              reason: 'implemented',
            }
          : null,
        admission: {
          admitted,
          commits: admitted ? [sha] : [],
          paths: admitted ? ['src/feature.ts'] : [],
          commands: admitted ? [{ toolCallId: 'call-implement', command: 'bun test', exitCode: 0, cwd: '/work' }] : [],
          remoteBranch: admitted ? 'feature/bounded' : null,
          remoteTip: admitted ? sha : null,
          published: false,
          reason: admitted ? 'admitted' : 'not admitted',
        },
        diagnostics: [],
      },
    }),
  )
}

describe('workflow records', () => {
  test('derives same-scope inputs and keeps external references out of inputs', () => {
    const parent = must(
      parseRecord({
        ...mandate('fix-only', { recordId: 'parent-mandate' }),
        repository: PARENT.repository,
        target: PARENT.target,
        operationId: 'op-parent',
      }),
    )
    const child = mandate('fix-only', { parent })
    expect(child.inputs).not.toContain(parent.recordId)
    expect(scopedRefsOf(child)).toEqual([expect.objectContaining({ recordId: parent.recordId, kind: 'mandate' })])
    expect(parseRecord({ ...child, inputs: [parent.recordId] }).ok).toBe(false)
  })

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

  test('accepts a new base commit when approved path and blob are unchanged', () => {
    const approved = 'a'.repeat(40)
    const advanced = 'b'.repeat(40)
    const blob = 'c'.repeat(40)
    const changed = 'd'.repeat(40)
    const path = 'plugins/omp-build/skills/dev-review/review-classes.yml'
    const stack = '.dev/stack.yml'
    const record = must(
      parseRecord({
        ...featureMandate(),
        payload: {
          ...featureMandate().payload,
          proofPins: [
            { sourceCommit: approved, path, blob },
            { sourceCommit: approved, path: stack, blob: null },
          ],
        },
      }),
    )
    const current = {
      productVersion: '0.11.0',
      configVersion: 'catalogue-1',
      configDigest: DIGEST,
      supportedConfigVersions: ['catalogue-1'],
      proofPins: [
        { sourceCommit: advanced, path: stack, blob: null },
        { sourceCommit: advanced, path, blob },
      ],
      specDigest: specDigest(BODY),
      specBody: BODY,
    }
    const native = { branch: 'feature/bounded', base: 'main', pullRequest: SCOPE, linkedIssueScopes: [SCOPE] }
    expect(
      requireLandingMandate({
        histories: [history([record, binding(record)])],
        native,
        parentScopes: [],
        current,
        localInhibit: null,
      }).ok,
    ).toBe(true)
    expect(
      requireLandingMandate({
        histories: [history([record, binding(record)])],
        native,
        parentScopes: [],
        current: {
          ...current,
          proofPins: [
            { sourceCommit: advanced, path, blob: changed },
            { sourceCommit: advanced, path: stack, blob: null },
          ],
        },
        localInhibit: null,
      }),
    ).toMatchObject({ ok: false, reason: 'proof-pin-drift' })
  })

  test('refuses a fix-only mandate at landing and does not treat pause as stop', () => {
    const record = mandate('fix-only')
    const landing = requireLandingMandate({
      histories: [history([record, binding(record)])],
      native: { branch: 'feature/bounded', base: 'main', pullRequest: SCOPE, linkedIssueScopes: [SCOPE] },
      parentScopes: [],
      current: {
        productVersion: '0.11.0',
        configVersion: 'catalogue-1',
        configDigest: DIGEST,
        supportedConfigVersions: ['catalogue-1'],
        proofPins: [],
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
        proof: { admission: null, candidateGitSHA: null, input: null, applicability: 'required', evidence: [] },
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
          run: 'run00001',
          children: [{ scope: SCOPE, specDigest: specDigest(BODY), specBody: BODY }],
          branch: null,
          base: 'main',
          lineageHead: null,
          config: child.payload.config,
          proofPins: [],
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
          run: 'run00002',
          children: [],
          branch: null,
          base: 'main',
          lineageHead: null,
          config: child.payload.config,
          proofPins: [],
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
          proof: { admission: null, candidateGitSHA: null, input: null, applicability: 'required', evidence: [] },
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
          proofPins: [],
          specDigest: specDigest(BODY),
          specBody: BODY,
        },
        localInhibit: null,
      }),
    ).toMatchObject({ ok: false })
  })

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
    const epicBuilt = mandate('fix-only', { recordId: 'epic-1' })
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
        history: history([mandate('fix-only')]),
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
  test('admits a current change attribution to fix and keeps a spent stop', () => {
    const built = mandate('feature')
    const graph = {
      version: 1,
      productVersion: '0.11.0',
      configVersion: 'catalogue-1',
      edgeOrder: 'array',
      nodes: [
        { id: 'ready', action: 'stop' },
        { id: 'attribute-ci', action: 'attribute-ci' },
        { id: 'fix', action: 'fix' },
        { id: 'stop', action: 'stop' },
      ],
      edges: [
        { from: 'ready', to: 'attribute-ci', when: 'ci-red' },
        { from: 'ready', to: 'fix', when: 'ci-attributed-change' },
        { from: 'ready', to: 'stop', when: 'ci-attribution-refused' },
        { from: 'ready', to: 'stop', when: 'review-step-stop' },
      ],
      initial: 'ready',
    }
    const parsed = must(
      parseRecord({
        ...built,
        payload: { ...built.payload, config: { ...built.payload.config, effective: { graph } } },
      }),
    )
    if (parsed.kind !== 'mandate') throw new Error('expected a mandate')
    const mandated = parsed
    const pr = { repository: 'acme/app', target: 'acme/app#99' }
    const step = {
      id: 'step-1',
      change: 'bind the check',
      doneWhen: 'the check is green',
      criterion: 'the named check passes',
      evidence: 'the captured command',
      paths: ['plugins/omp-build/engine/workflow.ts'],
    }
    expect(planOutputSchema.safeParse({ steps: [], resolutions: [] }).success).toBe(false)
    expect(planOutputSchema.safeParse({ steps: [step], resolutions: [] }).success).toBe(true)
    expect(
      planReviewSchema.safeParse({
        outcome: 'blocking',
        blockers: [
          { id: 'same', criterion: 'cover it', gap: 'missing' },
          { id: 'same', criterion: 'cover it', gap: 'missing' },
        ],
      }).success,
    ).toBe(false)
    expect(planMacro({ issue: history([mandated]), pullRequest: null, parents: [] }, mandated).phase).toBe(
      'needs-draft',
    )
    const failure = {
      name: 'test',
      source: 'ci',
      observationId: 'check-11',
      conclusion: 'FAILURE',
    }
    const rerun = { ...failure, observationId: 'check-12' }
    const evidenceDigest = failedCheckEvidenceDigest({ candidateGitSHA: 'abc', scope: pr, failures: [failure] })
    if (evidenceDigest === null) throw new Error('expected a check evidence digest')
    expect(failedCheckEvidenceDigest({ candidateGitSHA: 'abc', scope: pr, failures: [rerun] })).not.toBe(evidenceDigest)
    expect(
      parseRecord({
        version: 1,
        repository: pr.repository,
        target: pr.target,
        recordId: 'ci-names',
        runId: 'run-1',
        operationId: 'op-ci-names',
        inputs: [],
        kind: 'action-receipt',
        payload: {
          phase: 'result',
          action: 'attribute-ci',
          actionId: 'act-ci-names',
          mandate: { scope: SCOPE, recordId: mandated.recordId, kind: 'mandate' },
          start: { scope: pr, recordId: 'ci-start', kind: 'action-receipt' },
          exactInputs: { candidateGitSHA: 'abc', scope: pr, failedChecks: ['test'] },
          native: { completion: 'completed', strict: 'valid', raw: null },
          structured: { attribution: 'change', evidence: null },
          admission: null,
          diagnostics: [],
        },
      }).ok,
    ).toBe(false)
    const receipt = must(
      buildRecord({
        version: 1,
        repository: pr.repository,
        target: pr.target,
        recordId: 'ci-1',
        runId: 'run-1',
        operationId: 'op-ci-1',
        kind: 'action-receipt',
        payload: {
          phase: 'result',
          action: 'attribute-ci',
          actionId: 'act-ci-1',
          mandate: { scope: SCOPE, recordId: mandated.recordId, kind: 'mandate' },
          start: { scope: pr, recordId: 'ci-start', kind: 'action-receipt' },
          exactInputs: {
            candidateGitSHA: 'abc',
            scope: pr,
            failedChecks: ['test'],
            evidenceDigest,
            failures: [failure],
          },
          native: { completion: 'completed', strict: 'valid', raw: null },
          structured: { attribution: 'change', evidence: null },
          admission: null,
          diagnostics: [],
        },
      }),
    )
    const decisions = {
      reviewStep: 'fix' as const,
      epicStep: null,
      epicLand: null,
      ciWatchStatus: 'red' as const,
      publish: { status: 'not-applicable' as const, evidence: [] },
      landing: { status: 'not-applicable' as const, evidence: [] },
      watch: { status: 'not-applicable' as const, evidence: [] },
      proof: {
        admission: null,
        candidateGitSHA: null,
        input: null,
        applicability: 'not-applicable' as const,
        evidence: [],
      },
    }
    const shared = {
      evidence: { issue: history([mandated, binding(mandated)]), pullRequest: history([receipt], pr), parents: [] },
      facts: facts({
        candidateGitSHA: 'abc',
        pullRequest: { scope: pr, head: 'abc', base: 'main', associatedIssue: SCOPE },
        failedChecks: ['test'],
        evidenceDigest,
      }),
    }
    expect(reconstructWorkflow({ ...shared, decisions })).toMatchObject({ status: 'action', action: 'fix' })
    const unknownReceipt = must(
      parseRecord({
        ...receipt,
        recordId: 'ci-unknown',
        operationId: 'op-ci-unknown',
        payload: { ...receipt.payload, structured: { attribution: 'unknown', evidence: null } },
      }),
    )
    expect(
      reconstructWorkflow({
        ...shared,
        evidence: { ...shared.evidence, pullRequest: history([unknownReceipt], pr) },
        decisions,
      }),
    ).toMatchObject({ status: 'terminal', reason: 'ci-attribution-refused' })
    const rerunDigest = failedCheckEvidenceDigest({ candidateGitSHA: 'abc', scope: pr, failures: [rerun] })
    if (rerunDigest === null) throw new Error('expected CI evidence digest')
    expect(
      reconstructWorkflow({
        ...shared,
        facts: facts({ ...shared.facts, failedChecks: ['test'], evidenceDigest: rerunDigest }),
        decisions,
      }),
    ).toMatchObject({ status: 'action', action: 'attribute-ci' })
    const rerunStart = must(
      buildRecord({
        version: 1,
        repository: pr.repository,
        target: pr.target,
        recordId: 'ci-rerun-start',
        runId: 'run-1',
        operationId: 'op-ci-rerun-start',
        kind: 'action-receipt',
        payload: {
          phase: 'start',
          action: 'attribute-ci',
          actionId: 'act-ci-rerun',
          mandate: { scope: SCOPE, recordId: mandated.recordId, kind: 'mandate' },
          exactInputs: {
            candidateGitSHA: 'abc',
            scope: pr,
            failedChecks: ['test'],
            evidenceDigest: rerunDigest,
            failures: [rerun],
          },
        },
      }),
    )
    expect(
      reconstructWorkflow({
        ...shared,
        evidence: { ...shared.evidence, pullRequest: history([rerunStart], pr) },
        facts: facts({ ...shared.facts, failedChecks: ['test'], evidenceDigest: rerunDigest }),
        decisions,
      }),
    ).toMatchObject({ status: 'blocked', reason: 'action-uncertain' })
    expect(
      reconstructWorkflow({
        ...shared,
        decisions: { ...decisions, reviewStep: 'stop' },
      }),
    ).toMatchObject({ status: 'terminal', reason: 'bound-stop' })
  })

  test('returns the accepted spec bytes and refuses a malformed or inactive binding', () => {
    const mandated = featureMandate()
    if (mandated.kind !== 'mandate') throw new Error('expected a mandate')
    const current = 'ship the bounded workflow, clarified'
    const acceptedDigest = specDigest(BODY)
    const currentDigest = specDigest(current)
    const receipt = must(
      buildRecord({
        version: 1,
        repository: SCOPE.repository,
        target: SCOPE.target,
        recordId: 'assess-1',
        runId: 'run-1',
        operationId: 'op-assess-1',
        kind: 'action-receipt',
        payload: {
          phase: 'result',
          action: 'assess-spec',
          actionId: 'act-assess-1',
          mandate: { scope: SCOPE, recordId: mandated.recordId, kind: 'mandate' },
          start: { scope: SCOPE, recordId: 'assess-start', kind: 'action-receipt' },
          exactInputs: { acceptedDigest, currentDigest, acceptedBody: BODY, currentBody: current },
          native: { completion: 'completed', strict: 'valid', raw: null },
          structured: { classification: 'editorial' },
          admission: null,
          diagnostics: [],
        },
      }),
    )
    const start = must(
      buildRecord({
        version: 1,
        repository: SCOPE.repository,
        target: SCOPE.target,
        recordId: 'assess-start',
        runId: 'run-1',
        operationId: 'op-assess-start',
        kind: 'action-receipt',
        payload: {
          phase: 'start',
          action: 'assess-spec',
          actionId: 'act-assess-1',
          mandate: { scope: SCOPE, recordId: mandated.recordId, kind: 'mandate' },
          exactInputs: { acceptedDigest, currentDigest, acceptedBody: BODY, currentBody: current },
        },
      }),
    )
    const pr: Scope = { repository: 'acme/app', target: 'acme/app#99' }
    const native = { branch: 'feature/bounded', base: 'main' }
    const issue = history([mandated, start, receipt])
    const bound = resolveBoundWork({
      use: 'review',
      explicitSelection: true,
      pullRequest: pr,
      histories: [issue, history([binding(mandated, pr)], pr)],
      native,
      currentSpec: { body: current, digest: currentDigest },
    })
    expect(bound).toMatchObject({
      status: 'applicable',
      drift: 'settled',
      permissions: { landing: true, correct: true },
      acceptedSpec: { body: current, digest: currentDigest, reference: 'acme/app#42' },
      configIdentity: { additionalRequirements: [], digest: DIGEST },
    })
    expect(resolveAcceptedSpec(mandated, [issue])).toMatchObject({
      ok: true,
      spec: {
        body: current,
        chain: [{ kind: 'mandate' }, { kind: 'editorial', recordId: 'assess-1' }],
        sourceRefs: [
          { kind: 'mandate', recordId: mandated.recordId },
          { kind: 'action-receipt', recordId: 'assess-1' },
        ],
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
    ).toEqual({ status: 'standalone', binding: 'absent' })
    expect(
      resolveBoundWork({
        use: 'landing',
        explicitSelection: true,
        pullRequest: pr,
        histories: [history([], pr)],
        native,
      }),
    ).toMatchObject({ status: 'refused', reason: 'missing' })
    expect(
      resolveBoundWork({
        use: 'review',
        explicitSelection: true,
        pullRequest: pr,
        histories: [history([binding(mandated, pr)], pr)],
        native,
      }),
    ).toMatchObject({ status: 'refused', reason: 'incomplete' })
    const fixOnly = mandate('fix-only')
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

    const standaloneFix = mandate('fix-only')
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

  function assessFixture(
    mandated: CanonicalRecord,
    id: string,
    acceptedBody: string,
    currentBody: string,
    classification: 'editorial' | 'material' | 'unknown' | null,
    native: {
      completion: 'completed' | 'error' | 'cancelled' | 'incomplete'
      strict: 'valid' | 'invalid' | 'absent'
    } = {
      completion: 'completed',
      strict: 'valid',
    },
    mandateId = mandated.recordId,
  ) {
    const acceptedDigest = specDigest(acceptedBody)
    const currentDigest = specDigest(currentBody)
    const exactInputs = { acceptedDigest, currentDigest, acceptedBody, currentBody }
    const mandateRef = { scope: SCOPE, recordId: mandateId, kind: 'mandate' as const }
    const start = must(
      buildRecord({
        version: 1,
        repository: SCOPE.repository,
        target: SCOPE.target,
        recordId: `${id}-start`,
        runId: 'run-1',
        operationId: `op-${id}-start`,
        kind: 'action-receipt',
        payload: { phase: 'start', action: 'assess-spec', actionId: `act-${id}`, mandate: mandateRef, exactInputs },
      }),
    )
    const result = must(
      buildRecord({
        version: 1,
        repository: SCOPE.repository,
        target: SCOPE.target,
        recordId: id,
        runId: 'run-1',
        operationId: `op-${id}`,
        kind: 'action-receipt',
        payload: {
          phase: 'result',
          action: 'assess-spec',
          actionId: `act-${id}`,
          mandate: mandateRef,
          start: { scope: SCOPE, recordId: start.recordId, kind: 'action-receipt' },
          exactInputs,
          native: { ...native, raw: null },
          structured: classification === null ? null : { classification },
          admission: null,
          diagnostics: [],
        },
      }),
    )
    return { start, result, currentDigest }
  }

  test('requires a fresh authenticated assessment when the live spec changes after a completed material pair', () => {
    const feature = featureMandate()
    const mandated = must(
      parseRecord({
        ...feature,
        payload: {
          ...feature.payload,
          config: {
            ...feature.payload.config,
            version: WORKFLOW_CONFIG_VERSION,
            effective: { graph: shippedWorkflowGraph('0.11.0') },
          },
        },
      }),
    )
    if (mandated.kind !== 'mandate') throw new Error('expected a mandate')
    const bodyB = 'material body B'
    const bodyC = 'material body C'
    const historical = assessFixture(mandated, 'material-a-b', BODY, bodyB, 'material')
    const live = assessFixture(mandated, 'material-a-c', BODY, bodyC, 'material')
    const decisions = {
      reviewStep: null,
      epicStep: null,
      epicLand: null,
      ciWatchStatus: null,
      publish: { status: 'absent' as const, evidence: [] },
      landing: { status: 'absent' as const, evidence: [] },
      watch: { status: 'absent' as const, evidence: [] },
      proof: { admission: null, candidateGitSHA: null, input: null, applicability: 'required' as const, evidence: [] },
    }
    const staleEvidence = {
      issue: history([mandated, historical.start, historical.result]),
      pullRequest: null,
      parents: [],
    }
    const liveFacts = facts({
      configVersion: WORKFLOW_CONFIG_VERSION,
      supportedConfigVersions: [WORKFLOW_CONFIG_VERSION],
      specBody: bodyC,
      specDigest: specDigest(bodyC),
    })
    expect(reconstructWorkflow({ evidence: staleEvidence, facts: liveFacts, decisions })).toMatchObject({
      status: 'action',
      action: 'assess-spec',
      mandateId: mandated.recordId,
    })
    expect(
      reconstructWorkflow({
        evidence: { ...staleEvidence, issue: history([mandated, historical.start, historical.result, live.start]) },
        facts: liveFacts,
        decisions,
      }),
    ).toMatchObject({ status: 'blocked', reason: 'action-uncertain' })
  })

  test('does not treat a returned editorial Spec as a competing current-pair assessment', () => {
    const mandated = featureMandate()
    const bodyB = 'editorial body B'
    const bodyC = 'editorial body C'
    const first = assessFixture(mandated, 'editorial-a-b', BODY, bodyB, 'editorial')
    const second = assessFixture(mandated, 'editorial-b-c', bodyB, bodyC, 'editorial')
    const returned = assessFixture(mandated, 'editorial-c-b', bodyC, bodyB, 'editorial')
    const evidence = {
      issue: history([
        mandated,
        first.start,
        first.result,
        second.start,
        second.result,
        returned.start,
        returned.result,
      ]),
      pullRequest: null,
      parents: [],
    }
    expect(resolveAcceptedSpec(mandated, [evidence.issue])).toMatchObject({
      ok: true,
      spec: { body: bodyB, digest: specDigest(bodyB) },
    })
    expect(
      reconstructWorkflow({
        evidence,
        facts: facts({ specBody: bodyB, specDigest: specDigest(bodyB) }),
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
    ).toMatchObject({ status: 'action', mandateId: mandated.recordId })
  })
  test('does not let a predecessor material assessment govern its selected successor', () => {
    const predecessor = featureMandate()
    if (predecessor.kind !== 'mandate') throw new Error('expected a mandate')
    const successorBody = 'successor accepts the current Spec'
    const stale = assessFixture(predecessor, 'predecessor-material', BODY, successorBody, 'material')
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
    const successor = must(
      buildRecord({
        version: 1,
        repository: SCOPE.repository,
        target: SCOPE.target,
        recordId: 'mandate-successor',
        runId: 'run-1',
        operationId: 'op-mandate-successor',
        kind: 'mandate',
        payload: {
          ...predecessor.payload,
          antecedent: { scope: SCOPE, recordId: predecessor.recordId, kind: 'mandate' },
          spec: {
            ...predecessor.payload.spec,
            body: successorBody,
            bodySha256: specDigest(successorBody),
          },
        },
      }),
    )
    if (successor.kind !== 'mandate') throw new Error('expected a successor mandate')
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
          mandate: { scope: SCOPE, recordId: successor.recordId, kind: 'mandate' },
          predecessor: { scope: SCOPE, recordId: predecessor.recordId, kind: 'mandate' },
          successor: { scope: SCOPE, recordId: successor.recordId, kind: 'mandate' },
        },
      }),
    )
    const evidence = {
      issue: history([predecessor, stale.start, stale.result, abandoned, successor, selected]),
      pullRequest: null,
      parents: [],
    }
    expect(selectApplicableMandate(evidence.issue)).toMatchObject({
      status: 'applicable',
      mandate: { recordId: successor.recordId },
    })
    expect(
      reconstructWorkflow({
        evidence,
        facts: facts({ specBody: successorBody, specDigest: specDigest(successorBody) }),
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
    ).toMatchObject({ status: 'action', mandateId: successor.recordId })

    const first = assessFixture(successor, 'successor-material-a', successorBody, 'next Spec', 'material')
    const second = assessFixture(successor, 'successor-material-b', successorBody, 'next Spec', 'material')
    expect(
      reconstructWorkflow({
        evidence: {
          issue: history([successor, first.start, first.result, second.start, second.result]),
          pullRequest: null,
          parents: [],
        },
        facts: facts({ specBody: 'next Spec', specDigest: specDigest('next Spec') }),
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
    ).toMatchObject({ status: 'terminal', reason: 'spec-ambiguous' })
  })

  test('does not let a sibling, competing, or unreadable assessment approve a spec', () => {
    const mandated = featureMandate()
    if (mandated.kind !== 'mandate') throw new Error('expected a mandate')
    const editorial = assessFixture(mandated, 'edit', BODY, 'editorial body', 'editorial')
    const sibling = assessFixture(mandated, 'sibling', BODY, 'sibling body', 'editorial', undefined, 'other-mandate')
    const kept = resolveAcceptedSpec(mandated, [
      history([mandated, sibling.start, sibling.result, editorial.start, editorial.result]),
    ])
    expect(kept).toMatchObject({ ok: true, spec: { body: 'editorial body', digest: editorial.currentDigest } })
    const reversed = assessFixture(mandated, 'rev', BODY, 'other body', 'editorial')
    expect(
      resolveAcceptedSpec(mandated, [
        history([mandated, reversed.start, reversed.result, editorial.start, editorial.result]),
      ]),
    ).toMatchObject({
      ok: false,
      reason: 'ambiguous',
    })
    expect(
      resolveAcceptedSpec(mandated, [
        history([mandated, editorial.start, editorial.result, reversed.start, reversed.result]),
      ]),
    ).toMatchObject({
      ok: false,
      reason: 'ambiguous',
    })
    const unknown = assessFixture(mandated, 'unknown', BODY, 'unknown body', 'unknown')
    expect(
      resolveAcceptedSpec(mandated, [
        history([mandated, editorial.start, editorial.result, unknown.start, unknown.result]),
      ]),
    ).toMatchObject({
      ok: false,
      reason: 'ambiguous',
    })
    const malformed = assessFixture(mandated, 'malformed', BODY, 'malformed body', null)
    expect(resolveAcceptedSpec(mandated, [history([mandated, malformed.start, malformed.result])])).toMatchObject({
      ok: false,
      reason: 'incomplete',
    })
    expect(resolveAcceptedSpec(mandated, [history([mandated, editorial.start])])).toMatchObject({
      ok: false,
      reason: 'incomplete',
    })
    const second = must(parseRecord({ ...editorial.result, recordId: 'edit-again', operationId: 'op-edit-again' }))
    expect(
      resolveAcceptedSpec(mandated, [history([mandated, editorial.start, second, editorial.result])]),
    ).toMatchObject({
      ok: false,
      reason: 'ambiguous',
    })
    const failed = assessFixture(mandated, 'failed', BODY, 'failed body', 'editorial', {
      completion: 'error',
      strict: 'valid',
    })
    expect(resolveAcceptedSpec(mandated, [history([mandated, failed.start, failed.result])])).toMatchObject({
      ok: false,
      reason: 'incomplete',
    })
    const startBody = 'start-only body'
    const resultBody = 'result-only body'
    const driftedStart = must(
      buildRecord({
        version: 1,
        repository: SCOPE.repository,
        target: SCOPE.target,
        recordId: 'drift-start',
        runId: 'run-1',
        operationId: 'op-drift-start',
        kind: 'action-receipt',
        payload: {
          phase: 'start',
          action: 'assess-spec',
          actionId: 'act-drift',
          mandate: { scope: SCOPE, recordId: mandated.recordId, kind: 'mandate' },
          exactInputs: {
            acceptedDigest: specDigest(BODY),
            currentDigest: specDigest(startBody),
            acceptedBody: BODY,
            currentBody: startBody,
          },
        },
      }),
    )
    const driftedResult = must(
      buildRecord({
        version: 1,
        repository: SCOPE.repository,
        target: SCOPE.target,
        recordId: 'drift',
        runId: 'run-1',
        operationId: 'op-drift',
        kind: 'action-receipt',
        payload: {
          phase: 'result',
          action: 'assess-spec',
          actionId: 'act-drift',
          mandate: { scope: SCOPE, recordId: mandated.recordId, kind: 'mandate' },
          start: { scope: SCOPE, recordId: 'drift-start', kind: 'action-receipt' },
          exactInputs: {
            acceptedDigest: specDigest(BODY),
            currentDigest: specDigest(resultBody),
            acceptedBody: BODY,
            currentBody: resultBody,
          },
          native: { completion: 'completed', strict: 'valid', raw: null },
          structured: { classification: 'editorial' },
          admission: null,
          diagnostics: [],
        },
      }),
    )
    expect(resolveAcceptedSpec(mandated, [history([mandated, driftedStart, driftedResult])])).toMatchObject({
      ok: false,
      reason: 'incomplete',
    })
    const matched = assessFixture(mandated, 'material', BODY, 'material body', 'material')
    const accepted = must(
      buildRecord({
        version: 1,
        repository: SCOPE.repository,
        target: SCOPE.target,
        recordId: 'accept-material',
        runId: 'run-1',
        operationId: 'op-accept-material',
        kind: 'operator-control',
        payload: {
          control: 'accept-material',
          controlId: 'accept-material',
          mandate: { scope: SCOPE, recordId: mandated.recordId, kind: 'mandate' },
          predecessor: { scope: SCOPE, recordId: mandated.recordId, kind: 'mandate' },
          assessment: { scope: SCOPE, recordId: matched.result.recordId, kind: 'action-receipt' },
          specDigest: matched.currentDigest,
        },
      }),
    )
    expect(resolveAcceptedSpec(mandated, [history([mandated, matched.start, matched.result, accepted])])).toMatchObject(
      {
        ok: true,
        spec: { body: 'material body', digest: matched.currentDigest },
      },
    )
    const stale = assessFixture(mandated, 'stale', 'stale body', 'next body', 'material')
    const staleControl = must(
      buildRecord({
        version: 1,
        repository: SCOPE.repository,
        target: SCOPE.target,
        recordId: 'accept-stale',
        runId: 'run-1',
        operationId: 'op-accept-stale',
        kind: 'operator-control',
        payload: {
          control: 'accept-material',
          controlId: 'accept-stale',
          mandate: { scope: SCOPE, recordId: mandated.recordId, kind: 'mandate' },
          predecessor: { scope: SCOPE, recordId: mandated.recordId, kind: 'mandate' },
          assessment: { scope: SCOPE, recordId: stale.result.recordId, kind: 'action-receipt' },
          specDigest: stale.currentDigest,
        },
      }),
    )
    expect(resolveAcceptedSpec(mandated, [history([mandated, stale.start, stale.result, staleControl])])).toMatchObject(
      {
        ok: false,
        reason: 'material-spec',
      },
    )
    const materialClaim = assessFixture(mandated, 'claim', BODY, 'claimed body', 'material')
    expect(
      resolveAcceptedSpec(mandated, [
        history([mandated, materialClaim.start, materialClaim.result, editorial.start, editorial.result]),
      ]),
    ).toMatchObject({ ok: false, reason: 'ambiguous' })
  })

  test('binds planMacro to the accepted Spec after editorial advancement', () => {
    const feature = featureMandate()
    const mandated = must(
      parseRecord({
        ...feature,
        payload: {
          ...feature.payload,
          config: {
            ...feature.payload.config,
            version: WORKFLOW_CONFIG_VERSION,
            effective: { graph: shippedWorkflowGraph('0.11.0') },
          },
        },
      }),
    )
    if (mandated.kind !== 'mandate') throw new Error('expected a mandate')
    const originalDigest = mandated.payload.spec.bodySha256
    const advancedBody = 'editorial body'
    const editorial = assessFixture(mandated, 'edit', BODY, advancedBody, 'editorial')
    const advancedDigest = editorial.currentDigest
    expect(advancedDigest).not.toBe(originalDigest)
    const planOutput = {
      steps: [
        {
          id: 'step-1',
          change: 'bind the accepted Spec',
          doneWhen: 'the plan matches Spec B',
          criterion: 'exactInputs.specDigest is the accepted digest',
          evidence: 'planMacro.specDigest',
          paths: ['plugins/omp-build/engine/workflow.ts'],
        },
      ],
      resolutions: [],
    }
    const digest = planDigest(planOutput)
    const mandateRef = { scope: SCOPE, recordId: mandated.recordId, kind: 'mandate' as const }
    const slots = [
      { slotId: 'slot-architect', specialist: 'R-workflow-plan-architect' as const },
      { slotId: 'slot-adversarial', specialist: 'R-workflow-plan-adversarial' as const },
    ]
    const contribution = (slotId: string, specialist: string) => ({
      content: 'findings' as const,
      inventoryId: null,
      host: { origin: 'native' as const, phase: null, role: specialist, slotId, chunk: 0, childId: slotId },
      rawAttempts: [],
      native: { completion: 'completed' as const, strict: 'valid' as const, raw: null },
      structured: { outcome: 'clear', blockers: [] },
      findings: null,
    })
    const planPair = (actionId: string, specSha: string) => {
      const start = must(
        buildRecord({
          version: 1,
          repository: SCOPE.repository,
          target: SCOPE.target,
          recordId: `${actionId}-start`,
          runId: 'run-1',
          operationId: `op-${actionId}-start`,
          kind: 'action-receipt',
          payload: {
            phase: 'start',
            action: 'plan',
            actionId,
            mandate: mandateRef,
            exactInputs: {
              mandateId: mandated.recordId,
              specDigest: specSha,
              amendsReviewActionId: null,
              requiredBlockers: [],
            },
          },
        }),
      )
      const result = must(
        buildRecord({
          version: 1,
          repository: SCOPE.repository,
          target: SCOPE.target,
          recordId: `${actionId}-result`,
          runId: 'run-1',
          operationId: `op-${actionId}-result`,
          kind: 'action-receipt',
          payload: {
            phase: 'result',
            action: 'plan',
            actionId,
            mandate: mandateRef,
            start: { scope: SCOPE, recordId: start.recordId, kind: 'action-receipt' },
            exactInputs: {
              mandateId: mandated.recordId,
              specDigest: specSha,
              amendsReviewActionId: null,
              requiredBlockers: [],
            },
            native: { completion: 'completed', strict: 'valid', raw: null },
            structured: planOutput,
            admission: null,
            diagnostics: [],
          },
        }),
      )
      return [start, result] as const
    }
    const reviewPair = (actionId: string, draftActionId: string, specSha: string) => {
      const start = must(
        buildRecord({
          version: 1,
          repository: SCOPE.repository,
          target: SCOPE.target,
          recordId: `${actionId}-start`,
          runId: 'run-1',
          operationId: `op-${actionId}-start`,
          kind: 'action-receipt',
          payload: {
            phase: 'start',
            action: 'plan-review',
            actionId,
            mandate: mandateRef,
            exactInputs: {
              mandateId: mandated.recordId,
              specDigest: specSha,
              planDigest: digest,
              draftActionId,
            },
            slots,
          },
        }),
      )
      const result = must(
        buildRecord({
          version: 1,
          repository: SCOPE.repository,
          target: SCOPE.target,
          recordId: `${actionId}-result`,
          runId: 'run-1',
          operationId: `op-${actionId}-result`,
          kind: 'action-receipt',
          payload: {
            phase: 'result',
            action: 'plan-review',
            actionId,
            mandate: mandateRef,
            start: { scope: SCOPE, recordId: start.recordId, kind: 'action-receipt' },
            exactInputs: {
              mandateId: mandated.recordId,
              specDigest: specSha,
              planDigest: digest,
              draftActionId,
            },
            slots,
            contributions: [
              contribution('slot-architect', 'R-workflow-plan-architect'),
              contribution('slot-adversarial', 'R-workflow-plan-adversarial'),
            ],
            native: { completion: 'completed', strict: 'valid', raw: null },
            structured: null,
            admission: null,
            diagnostics: [],
          },
        }),
      )
      return [start, result] as const
    }
    const [oldStart, oldResult] = planPair('act-plan-a', originalDigest)
    const [oldReviewStart, oldReview] = reviewPair('act-plan-review-a', 'act-plan-a', originalDigest)
    const advanced = history([
      mandated,
      editorial.start,
      editorial.result,
      oldStart,
      oldResult,
      oldReviewStart,
      oldReview,
    ])
    const stale = planMacro({ issue: advanced, pullRequest: null, parents: [] }, mandated)
    expect(stale).toMatchObject({
      phase: 'needs-draft',
      specDigest: advancedDigest,
    })
    expect(stale.phase).not.toBe('eligible')

    const [newStart, newResult] = planPair('act-plan-b', advancedDigest)
    const [newReviewStart, newReview] = reviewPair('act-plan-review-b', 'act-plan-b', advancedDigest)
    const bound = planMacro(
      {
        issue: history([
          mandated,
          editorial.start,
          editorial.result,
          oldStart,
          oldResult,
          oldReviewStart,
          oldReview,
          newStart,
          newResult,
          newReviewStart,
          newReview,
        ]),
        pullRequest: null,
        parents: [],
      },
      mandated,
    )
    expect(bound).toMatchObject({
      phase: 'eligible',
      specDigest: advancedDigest,
      draftActionId: 'act-plan-b',
      reviewActionId: 'act-plan-review-b',
    })
    const eligibleRecords = [
      mandated,
      editorial.start,
      editorial.result,
      oldStart,
      oldResult,
      oldReviewStart,
      oldReview,
      newStart,
      newResult,
      newReviewStart,
      newReview,
    ]
    const workflowFacts = facts({
      specDigest: advancedDigest,
      specBody: advancedBody,
      configVersion: WORKFLOW_CONFIG_VERSION,
      supportedConfigVersions: [WORKFLOW_CONFIG_VERSION],
    })
    const workflowDecisions: SpecializedDecisions = {
      reviewStep: null,
      epicStep: null,
      epicLand: null,
      ciWatchStatus: null,
      publish: { status: 'absent', evidence: [] },
      landing: { status: 'absent', evidence: [] },
      watch: { status: 'absent', evidence: [] },
      proof: { admission: null, candidateGitSHA: null, input: null, applicability: 'required', evidence: [] },
    }
    const oldImplementationStart = implementationStart(mandated, 'act-implement-a', 'act-plan-a')
    const oldImplementationResult = implementationResult(
      mandated,
      oldImplementationStart,
      'act-implement-a',
      'act-plan-a',
      true,
    )
    const currentImplementation = reconstructWorkflow({
      evidence: {
        issue: history([...eligibleRecords, oldImplementationStart, oldImplementationResult]),
        pullRequest: null,
        parents: [],
      },
      facts: workflowFacts,
      decisions: workflowDecisions,
    })
    expect(currentImplementation).toMatchObject({ status: 'action', action: 'implement' })

    const unmatchedOldStart = implementationStart(mandated, 'act-implement-open', 'act-plan-a')
    const oldUncertain = reconstructWorkflow({
      evidence: {
        issue: history([
          mandated,
          editorial.start,
          editorial.result,
          oldStart,
          oldResult,
          oldReviewStart,
          oldReview,
          unmatchedOldStart,
        ]),
        pullRequest: null,
        parents: [],
      },
      facts: workflowFacts,
      decisions: workflowDecisions,
    })
    expect(oldUncertain).toMatchObject({ status: 'blocked', reason: 'action-uncertain' })

    const currentImplementationStart = implementationStart(mandated, 'act-implement-b', 'act-plan-b')
    const currentUncertain = reconstructWorkflow({
      evidence: {
        issue: history([
          ...eligibleRecords,
          oldImplementationStart,
          oldImplementationResult,
          currentImplementationStart,
        ]),
        pullRequest: null,
        parents: [],
      },
      facts: workflowFacts,
      decisions: workflowDecisions,
    })
    expect(currentUncertain).toMatchObject({ status: 'blocked', reason: 'action-uncertain' })

    const currentImplementationResult = implementationResult(
      mandated,
      currentImplementationStart,
      'act-implement-b',
      'act-plan-b',
      true,
    )
    const published = reconstructWorkflow({
      evidence: {
        issue: history([
          ...eligibleRecords,
          oldImplementationStart,
          oldImplementationResult,
          currentImplementationStart,
          currentImplementationResult,
        ]),
        pullRequest: null,
        parents: [],
      },
      facts: workflowFacts,
      decisions: workflowDecisions,
    })
    expect(published).toMatchObject({ status: 'action', action: 'publish' })
    const pull: Scope = { repository: SCOPE.repository, target: 'acme/app#99' }
    const boundPull = history([binding(mandated, pull)], pull)
    const proof = reconstructWorkflow({
      evidence: {
        issue: history([
          ...eligibleRecords,
          oldImplementationStart,
          oldImplementationResult,
          currentImplementationStart,
          currentImplementationResult,
        ]),
        pullRequest: boundPull,
        parents: [],
      },
      facts: {
        ...workflowFacts,
        pullRequest: { scope: pull, head: 'abc', base: 'main', associatedIssue: SCOPE },
      },
      decisions: workflowDecisions,
    })
    expect(proof).toMatchObject({ status: 'action', action: 'proof' })

    const abandoned = must(
      buildRecord({
        version: 1,
        repository: SCOPE.repository,
        target: SCOPE.target,
        recordId: 'abandon-mandate-1',
        runId: 'run-1',
        operationId: 'op-abandon-mandate-1',
        kind: 'operator-control',
        payload: { control: 'abandon', controlId: 'abandon-mandate-1', mandate: mandateRef, predecessor: null },
      }),
    )
    const successorBase = must(
      buildFixOnlyMandate({
        scope: SCOPE,
        recordId: 'mandate-2',
        runId: 'run-2',
        operationId: 'op-mandate-2',
        branch: 'feature/bounded',
        base: 'main',
        lineageHead: null,
        productVersion: '0.11.0',
        work: { reference: SCOPE.target, body: BODY, lastEditedAt: '2026-10-21T00:00:00Z' },
        config: mandated.payload.config,
        proofPins: [],
        parent: null,
        antecedent: mandateRef,
      }),
    )
    const successor = must(
      parseRecord({
        ...successorBase,
        payload: {
          ...successorBase.payload,
          role: 'feature',
          permissions: { landing: true, correct: true },
        },
      }),
    )
    if (successor.kind !== 'mandate') throw new Error('expected a mandate')
    const successorRef = { scope: SCOPE, recordId: successor.recordId, kind: 'mandate' as const }
    const selectedSuccessor = must(
      buildRecord({
        version: 1,
        repository: SCOPE.repository,
        target: SCOPE.target,
        recordId: 'select-mandate-2',
        runId: 'run-2',
        operationId: 'op-select-mandate-2',
        kind: 'operator-control',
        payload: {
          control: 'select-successor',
          controlId: 'select-mandate-2',
          mandate: successorRef,
          predecessor: mandateRef,
          successor: successorRef,
        },
      }),
    )
    const successorHistory = history([mandated, oldStart, oldResult, abandoned, successor, selectedSuccessor])
    expect(selectApplicableMandate(successorHistory)).toMatchObject({
      status: 'applicable',
      mandate: { recordId: successor.recordId },
    })
    expect(planMacro({ issue: successorHistory, pullRequest: null, parents: [] }, successor)).toMatchObject({
      phase: 'needs-draft',
      draftActionId: null,
    })
    const antecedentOpenPlanStart = must(
      buildRecord({
        version: 1,
        repository: SCOPE.repository,
        target: SCOPE.target,
        recordId: 'act-plan-open-start',
        runId: 'run-1',
        operationId: 'op-act-plan-open-start',
        kind: 'action-receipt',
        payload: {
          phase: 'start',
          action: 'plan',
          actionId: 'act-plan-open',
          mandate: mandateRef,
          exactInputs: {
            mandateId: mandated.recordId,
            specDigest: originalDigest,
            amendsReviewActionId: null,
            requiredBlockers: [],
          },
        },
      }),
    )
    const antecedentUncertain = reconstructWorkflow({
      evidence: {
        issue: history([mandated, antecedentOpenPlanStart, abandoned, successor, selectedSuccessor]),
        pullRequest: null,
        parents: [],
      },
      facts: facts({
        configVersion: WORKFLOW_CONFIG_VERSION,
        supportedConfigVersions: [WORKFLOW_CONFIG_VERSION],
      }),
      decisions: workflowDecisions,
    })
    expect(antecedentUncertain).toMatchObject({ status: 'blocked', reason: 'action-uncertain' })

    const malformed = assessFixture(mandated, 'broken', BODY, advancedBody, null)
    const blocked = planMacro(
      {
        issue: history([mandated, malformed.start, malformed.result, newStart, newResult, newReviewStart, newReview]),
        pullRequest: null,
        parents: [],
      },
      mandated,
    )
    expect(blocked.phase).toBe('blocked')
    expect(blocked.specDigest).toBeNull()
    expect(blocked.evidence.some((item) => item.code === 'incomplete')).toBe(true)
  })

  test('does not let an open or rejected implement reach proof because a pull request exists', () => {
    const feature = featureMandate()
    if (feature.kind !== 'mandate') throw new Error('expected a mandate')
    const shipped = must(
      parseRecord({
        ...feature,
        payload: {
          ...feature.payload,
          config: {
            ...feature.payload.config,
            version: WORKFLOW_CONFIG_VERSION,
            effective: { graph: shippedWorkflowGraph('0.11.0') },
          },
        },
      }),
    )
    if (shipped.kind !== 'mandate') throw new Error('expected a mandate')
    const pull: Scope = { repository: 'acme/app', target: 'acme/app#99' }
    const start = implementationStart(shipped, 'act-implement', 'plan-missing')
    const rejected = implementationResult(shipped, start, 'act-implement', 'plan-missing', false)
    const decisions: SpecializedDecisions = {
      reviewStep: null,
      epicStep: null,
      epicLand: null,
      ciWatchStatus: null,
      publish: { status: 'absent', evidence: [] },
      landing: { status: 'absent', evidence: [] },
      watch: { status: 'absent', evidence: [] },
      proof: { admission: null, candidateGitSHA: null, input: null, applicability: 'required' as const, evidence: [] },
    }
    const shippedFacts = facts({
      configVersion: WORKFLOW_CONFIG_VERSION,
      supportedConfigVersions: [WORKFLOW_CONFIG_VERSION],
      pullRequest: { scope: pull, head: 'abc', base: 'main', associatedIssue: SCOPE },
    })
    const bound = history([binding(shipped, pull)], pull)
    const open = reconstructWorkflow({
      evidence: { issue: history([shipped, start]), pullRequest: bound, parents: [] },
      facts: shippedFacts,
      decisions,
    })
    expect(open).toMatchObject({ status: 'blocked', reason: 'action-uncertain' })
    expect(open).not.toMatchObject({ status: 'action', action: 'proof' })
    const rejectedDecision = reconstructWorkflow({
      evidence: { issue: history([shipped, start, rejected]), pullRequest: bound, parents: [] },
      facts: shippedFacts,
      decisions,
    })
    expect(rejectedDecision).toMatchObject({ status: 'blocked', reason: 'unconfirmed' })
    expect(rejectedDecision).not.toMatchObject({ status: 'action', action: 'proof' })
    const adopted = reconstructWorkflow({
      evidence: { issue: history([shipped]), pullRequest: bound, parents: [] },
      facts: shippedFacts,
      decisions,
    })
    expect(adopted).toMatchObject({ status: 'action', action: 'proof' })
    expect(history([shipped]).operations.some((operation) => operation.record?.kind === 'action-receipt')).toBe(false)
    const nativeOnly = reconstructWorkflow({
      evidence: { issue: history([shipped]), pullRequest: history([], pull), parents: [] },
      facts: shippedFacts,
      decisions,
    })
    expect(nativeOnly).toMatchObject({ status: 'action', action: 'plan' })
    expect(nativeOnly).not.toMatchObject({ status: 'action', action: 'proof' })
  })

  test('retains an unmatched CI attribution when the current candidate changes', () => {
    const feature = featureMandate()
    const shipped = must(
      parseRecord({
        ...feature,
        payload: {
          ...feature.payload,
          config: {
            ...feature.payload.config,
            version: WORKFLOW_CONFIG_VERSION,
            effective: { graph: shippedWorkflowGraph('0.11.0') },
          },
        },
      }),
    )
    if (shipped.kind !== 'mandate') throw new Error('expected a mandate')
    const pull: Scope = { repository: SCOPE.repository, target: 'acme/app#99' }
    const oldCandidate = 'a'.repeat(40)
    const currentCandidate = 'b'.repeat(40)
    const oldFailure = {
      name: 'old-check',
      source: 'check-run',
      observationId: 'old-observation',
      conclusion: 'failure',
    }
    const currentFailure = {
      name: 'current-check',
      source: 'check-run',
      observationId: 'current-observation',
      conclusion: 'failure',
    }
    const oldDigest = failedCheckEvidenceDigest({
      candidateGitSHA: oldCandidate,
      scope: pull,
      failures: [oldFailure],
    })
    const currentDigest = failedCheckEvidenceDigest({
      candidateGitSHA: currentCandidate,
      scope: pull,
      failures: [currentFailure],
    })
    if (oldDigest === null || currentDigest === null) throw new Error('expected CI evidence digests')
    const staleStart = must(
      buildRecord({
        version: 1,
        repository: SCOPE.repository,
        target: SCOPE.target,
        recordId: 'attribute-ci-old-start',
        runId: 'run-1',
        operationId: 'op-attribute-ci-old-start',
        kind: 'action-receipt',
        payload: {
          phase: 'start',
          action: 'attribute-ci',
          actionId: 'act-attribute-ci-old',
          mandate: { scope: SCOPE, recordId: shipped.recordId, kind: 'mandate' },
          exactInputs: {
            candidateGitSHA: oldCandidate,
            scope: pull,
            failedChecks: [oldFailure.name],
            evidenceDigest: oldDigest,
            failures: [oldFailure],
          },
        },
      }),
    )
    const decision = reconstructWorkflow({
      evidence: {
        issue: history([shipped, staleStart]),
        pullRequest: history([binding(shipped, pull)], pull),
        parents: [],
      },
      facts: facts({
        candidateGitSHA: currentCandidate,
        configVersion: WORKFLOW_CONFIG_VERSION,
        supportedConfigVersions: [WORKFLOW_CONFIG_VERSION],
        pullRequest: { scope: pull, head: currentCandidate, base: 'main', associatedIssue: SCOPE },
        failedChecks: [currentFailure.name],
        evidenceDigest: currentDigest,
      }),
      decisions: {
        reviewStep: 'fix',
        epicStep: null,
        epicLand: null,
        ciWatchStatus: 'red',
        publish: { status: 'absent', evidence: [] },
        landing: { status: 'absent', evidence: [] },
        watch: { status: 'absent', evidence: [] },
        proof: { admission: null, candidateGitSHA: null, input: null, applicability: 'required', evidence: [] },
      },
    })
    expect(decision).toMatchObject({ status: 'blocked', reason: 'action-uncertain' })
    const greenDecision = reconstructWorkflow({
      evidence: {
        issue: history([shipped, staleStart]),
        pullRequest: history([binding(shipped, pull)], pull),
        parents: [],
      },
      facts: facts({
        candidateGitSHA: currentCandidate,
        configVersion: WORKFLOW_CONFIG_VERSION,
        supportedConfigVersions: [WORKFLOW_CONFIG_VERSION],
        pullRequest: { scope: pull, head: currentCandidate, base: 'main', associatedIssue: SCOPE },
        failedChecks: [],
        evidenceDigest: null,
      }),
      decisions: {
        reviewStep: null,
        epicStep: null,
        epicLand: null,
        ciWatchStatus: 'green',
        publish: { status: 'absent', evidence: [] },
        landing: { status: 'absent', evidence: [] },
        watch: { status: 'absent', evidence: [] },
        proof: { admission: null, candidateGitSHA: null, input: null, applicability: 'required', evidence: [] },
      },
    })
    expect(greenDecision).toMatchObject({ status: 'blocked', reason: 'action-uncertain' })
  })
})
