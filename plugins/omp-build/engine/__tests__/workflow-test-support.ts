import { createWorkflowFixtures } from '../../testing/workflow-fixtures.ts'
import type { DecodedHistory } from '../history-schema.ts'
import { buildRecord, parseRecord } from '../record-construction.ts'
import { isWorkflowKind } from '../record-references.ts'
import type { CanonicalRecord } from '../record-schema.ts'
import type { Scope } from '../record-values.ts'
import type { MandateRecord } from '../workflow-control.ts'
import type { WorkflowGraph } from '../workflow-graph.ts'
import type { WorkflowFacts } from '../workflow-reconstruction-types.ts'

const SCOPE: Scope = { repository: 'acme/app', target: 'acme/app#42' }
const PARENT: Scope = { repository: 'acme/app', target: 'acme/app#7' }
const DIGEST = 'a'.repeat(64)
const BODY = 'ship the bounded workflow'
const GRAPH: WorkflowGraph = {
  version: 1,
  productVersion: '0.13.0',
  configVersion: 'omp-build-workflow/1',
  edgeOrder: 'array',
  nodes: [
    { id: 'frame', action: 'frame' },
    { id: 'land', action: 'land' },
    { id: 'stop', action: 'stop' },
  ],
  edges: [{ from: 'frame', to: 'land', when: 'always' }],
  initial: 'land',
}
const WORKFLOW_CONFIG_VERSION = GRAPH.configVersion
const syntheticWorkflowFixtures = createWorkflowFixtures({
  productVersion: '0.13.0',
  config: { version: WORKFLOW_CONFIG_VERSION, digest: DIGEST, effective: { graph: GRAPH } },
  head: null,
  editedAt: '2026-10-21T00:00:00Z',
})

function must<T>(result: { ok: true; value: T } | { ok: false; diagnostics: { code: string }[] }): T {
  if (!result.ok) throw new Error(result.diagnostics.map((item) => item.code).join(','))
  return result.value
}

function mandate(overrides: { parent?: CanonicalRecord | null; recordId?: string; scope?: Scope } = {}) {
  const parent = overrides.parent
  const scope = overrides.scope ?? SCOPE
  return syntheticWorkflowFixtures.fixOnlyMandate(scope, {
    recordId: overrides.recordId ?? 'mandate-1',
    runId: 'run-1',
    operationId: 'op-mandate-1',
    branch: 'feature/bounded',
    base: 'main',
    lineageHead: null,
    body: BODY,
    parent:
      parent === undefined || parent === null
        ? null
        : {
            scope: { repository: parent.repository, target: parent.target },
            recordId: parent.recordId,
            kind: parent.kind,
          },
  })
}

function featureMandate(): MandateRecord {
  const record = syntheticWorkflowFixtures.featureMandate(SCOPE, {
    recordId: 'mandate-1',
    runId: 'run-1',
    operationId: 'op-mandate-1',
    branch: 'feature/bounded',
    base: 'main',
    lineageHead: null,
    body: BODY,
  })
  if (record.kind !== 'mandate') throw new Error('fixture is not a mandate')
  return record
}

function history(records: CanonicalRecord[], scope = SCOPE): DecodedHistory {
  const complete = [...records]
  for (const mandate of records) {
    if (mandate.kind !== 'mandate') continue
    for (const ref of mandate.payload.ownSpec.identityAllocations) {
      if (
        complete.some(
          (record) =>
            record.repository === ref.scope.repository &&
            record.target === ref.scope.target &&
            record.recordId === ref.recordId,
        )
      )
        continue
      complete.unshift(syntheticWorkflowFixtures.identityAllocation(ref.scope, ref.recordId))
    }
  }
  return {
    source: { scope, expectedAuthor: 'operator', stopAuthor: null, complete: true, comments: [], diagnostics: [] },
    operations: complete.map((record) => ({
      operationId: record.operationId,
      recordId: record.recordId,
      kind: record.kind,
      status: 'complete',
      authority: isWorkflowKind(record.kind) ? 'accounted' : 'authority',
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
    currentSpec: null,
    identityAllocations: null,
    base: 'main',
    candidateGitSHA: null,
    pullRequest: null,
    merged: false,
    sessionCwd: '/work',
    preparedWorktree: '/work',
    productVersion: '0.13.0',
    configVersion: 'omp-build-workflow/1',
    configDigest: DIGEST,
    supportedConfigVersions: ['omp-build-workflow/1'],
    explicitSelection: false,
    explicitResume: false,
    successorAntecedent: null,
    endObligationsMet: false,
    localInhibit: null,
    ...overrides,
  }
}

export { BODY, binding, DIGEST, facts, featureMandate, history, mandate, must, PARENT, pauseControls, SCOPE }
