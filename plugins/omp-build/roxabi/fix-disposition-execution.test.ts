import { describe, expect, it, vi } from 'vitest'
import { rawSource } from '../adapters/github-native/uw-spec.ts'
import type { CanonicalRecord, DecodedHistory } from '../dist/contracts.js'
import { assessCauseHolds, buildRecord, parseRecord } from '../dist/contracts.js'
import { assessUwCompletion } from '../engine/uw-completion.ts'
import { synthesisActionCapture } from '../testing/criterion-dispositions.ts'
import { fixtureHostReviewClassCatalogues } from '../testing/host-catalogue-fixture.ts'
import { submission } from '../testing/record-builders.ts'
import { acceptedPullRequestReviewGraph, reviewGraph } from '../testing/record-graphs.ts'
import { observedComment, operation } from '../testing/record-history.ts'
import { roxabiWorkflowFixtures } from '../testing/roxabi-presets.ts'
import type { FixIdentity } from './fix-contract.ts'
import { persistCauseDispositions } from './fix-disposition-execution.ts'

const original = { repository: 'Acme/app', target: 'Acme/app#12' }
const nativeGraph = {
  status: 'complete' as const,
  root: original,
  observedAt: '2026-10-27T12:00:00Z',
  nodes: [
    {
      uw: original,
      title: 'Original correction',
      raw: rawSource(original.target, 'Correct the original issue', '2026-10-27T12:00:00Z'),
      updatedAt: '2026-10-27T12:00:00Z',
      labels: ['size:S'],
      wayfinderLabels: [],
      parent: null,
      children: [],
      blockers: [],
      native: { state: 'OPEN' as const, stateReason: null },
    },
  ],
}
function holds(histories: readonly DecodedHistory[]) {
  const observation = {
    status: 'complete' as const,
    root: original,
    graph: nativeGraph,
    histories,
    catalogues: fixtureHostReviewClassCatalogues(),
    delivery: [],
  }
  const completion = assessUwCompletion(observation)
  return assessCauseHolds({ uw: original, waits: completion.waits, dependencies: completion.dependencies })
}
const identity: FixIdentity = { runId: 'run', operationId: 'operation', nextRecordId: () => 'unused' }

function acceptedReview(label: 'issue' | 'suggestion' = 'issue') {
  const fixtures = roxabiWorkflowFixtures()
  const mandate = fixtures.fixOnlyMandate(original)
  const binding = fixtures.workflowBinding(
    { repository: 'Acme/app', target: 'Acme/app#42' },
    mandate,
    'fix/42-save',
    'main',
  )
  const graph = acceptedPullRequestReviewGraph({ mandate, binding, prefix: 'disposition-transition', label })
  const inputs = graph.inputs
  if (inputs.manifest.spec.kind !== 'accepted') throw new Error('accepted fixture required')
  const origin = fixtures.historyFrom([mandate])
  const prepared = {
    target: {
      ...graph.history.source.scope,
      number: 42,
      kind: 'pull-request' as const,
      state: 'open' as const,
      candidateGitSHA: inputs.manifest.code.head,
      baseGitSHA: inputs.manifest.code.base,
    },
    requestId: 'request-disposition',
    inventoryId: graph.root.recordId,
    batch: {
      operationId: 'op-disposition',
      tasks: { context: 'No correction is dispatched in these refusal cases', tasks: [] },
    },
    sourceContributionId: graph.panel.recordId,
    policy: { version: 'baseline' as const },
    cwd: '/fixture',
    publishBinding: {
      pushUrl: 'https://github.com/Acme/app.git',
      publicationRepository: original.repository,
      localBranch: 'fix/42-save',
      destinationRef: 'refs/heads/fix/42-save',
      localHead: inputs.manifest.code.head,
      expectedRemoteSHA: inputs.manifest.code.head,
      defaultBranch: 'main',
      observed: {},
    },
    subject: inputs.manifest.subject,
    causeContext: { original, effective: inputs.manifest.spec.effective },
    capture: { kind: 'action' as const, input: synthesisActionCapture(graph.decision, [graph.history, origin]) },
    graph: nativeGraph,
  }
  return { graph, origin, prepared }
}

function consumer(origin: DecodedHistory, target: DecodedHistory) {
  let current = origin
  const saved: Extract<CanonicalRecord, { kind: 'cause-disposition' }>[] = []
  const dispositionStore = {
    read: vi.fn(async () => ({ ok: true as const, value: [current, target] })),
    catalogues: async () => fixtureHostReviewClassCatalogues(),
    publish: vi.fn(async (item: Extract<CanonicalRecord, { kind: 'cause-disposition' }>) => {
      saved.push(item)
      const observed = operation(item, {
        authority: 'accounted',
        parts: [observedComment({ author: current.source.expectedAuthor })],
      })
      current = { ...current, operations: [...current.operations, observed] }
      return { status: 'confirmed' as const, operation: observed }
    }),
  }
  return { saved, dispositionStore }
}

describe('correction disposition ingress', () => {
  it('persists a nonblocking report on its authenticated original', async () => {
    const { graph, origin, prepared } = acceptedReview('suggestion')
    const product = consumer(origin, graph.history)
    const result = await persistCauseDispositions(
      prepared,
      { kind: 'decision', decision: graph.decision },
      identity,
      product.dispositionStore,
    )
    expect(result.ok).toBe(true)
    expect(product.saved).toEqual([
      expect.objectContaining({
        repository: original.repository,
        target: original.target,
        payload: expect.objectContaining({
          outcome: expect.objectContaining({ state: 'final', disposition: 'report', blocking: false }),
        }),
      }),
    ])
  })
  it('persists and holds an unassigned exclusion rule error alongside an otherwise valid cause', async () => {
    const { graph, origin, prepared } = acceptedReview()
    const finding = graph.decision.payload.judgment.findings[0]
    if (!finding?.target) throw new Error('authenticated finding target required')
    const judgment = {
      ...graph.decision.payload.judgment,
      exclusionClaims: [
        {
          sourceFindingId: 'unknown-source',
          target: finding.target,
          exclusion: { spec: prepared.causeContext.effective.own, index: 0 },
          concern: 'additional-work' as const,
          reason: 'This claim must remain visible even without an assigned finding',
        },
      ],
    }
    const parsedDecision = parseRecord({ ...graph.decision, payload: { ...graph.decision.payload, judgment } })
    const parsedSynthesis = parseRecord({
      ...graph.synthesisContribution,
      payload: {
        ...graph.synthesisContribution.payload,
        structured: judgment,
        rawAttempts: graph.synthesisContribution.payload.rawAttempts.map((attempt) => ({ ...attempt, data: judgment })),
      },
    })
    if (
      !parsedDecision.ok ||
      parsedDecision.value.kind !== 'decision' ||
      !parsedSynthesis.ok ||
      parsedSynthesis.value.kind !== 'contribution'
    )
      throw new Error('authenticated decision fixture invalid')
    const decision = parsedDecision.value
    const synthesis = parsedSynthesis.value
    const target = {
      ...graph.history,
      operations: graph.history.operations.map((item) =>
        item.recordId === decision.recordId
          ? operation(decision)
          : item.recordId === synthesis.recordId
            ? operation(synthesis)
            : item,
      ),
    }
    const product = consumer(origin, target)
    let sequence = 0
    const result = await persistCauseDispositions(
      { ...prepared, capture: { kind: 'action', input: synthesisActionCapture(decision, [target, origin]) } },
      { kind: 'decision', decision },
      { ...identity, nextRecordId: () => `disposition-${++sequence}` },
      product.dispositionStore,
    )
    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) throw new Error('disposition persistence refused')
    expect(result.value.pending).toBe(true)
    expect(product.saved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({
            subject: expect.objectContaining({
              kind: 'rule-error',
              diagnostic: expect.objectContaining({ code: 'unknown-reference' }),
            }),
            outcome: expect.objectContaining({ state: 'pending-blocking' }),
          }),
        }),
      ]),
    )
    const readback = await product.dispositionStore.read()
    if (!readback.ok) throw new Error('readback unavailable')
    const holdsResult = holds(readback.value)
    expect(holdsResult).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'cause-adjudication-required' })]),
    )
  })
  it('persists a hold for an unknown exclusion in an otherwise empty authenticated correction', async () => {
    const base = acceptedReview()
    const scope = { repository: base.graph.decision.repository, target: base.graph.decision.target }
    const graph = reviewGraph({
      prefix: 'empty-exclusion',
      empty: true,
      inputs: base.graph.inputs,
      scope,
      head: base.graph.inputs.manifest.code.head,
    })
    const existingTarget = base.graph.decision.payload.judgment.findings[0]?.target
    if (!existingTarget || graph.root.payload.stage !== 'initial') throw new Error('fixture target or root missing')
    const old = graph.decision.payload.judgment
    const judgment = {
      format: old.format,
      policy: old.policy,
      sourceContributionIds: old.sourceContributionIds,
      findings: [],
      causes: [],
      unassignedFindings: [],
      purpose: 'correction' as const,
      exclusionClaims: [
        {
          sourceFindingId: 'unknown-empty-source',
          target: existingTarget,
          exclusion: { spec: base.prepared.causeContext.effective.own, index: 0 },
          concern: 'additional-work' as const,
          reason: 'Unknown source must not disappear',
        },
      ],
    }
    const required = <T>(result: { ok: true; value: T } | { ok: false; diagnostics: readonly unknown[] }): T => {
      if (!result.ok) throw new Error(`fixture invalid: ${JSON.stringify(result.diagnostics)}`)
      return result.value
    }
    const requestContribution = required(
      parseRecord({
        version: 1,
        ...scope,
        recordId: 'empty-request-source',
        runId: 'run',
        operationId: 'empty-source-op',
        inputs: [],
        kind: 'contribution',
        payload: {
          content: 'operator-request',
          inventoryId: null,
          host: { origin: 'operator', phase: 'fix', role: 'operator', slotId: null, chunk: null, childId: null },
          rawAttempts: [
            { attemptIndex: 0, data: null, raw: { operatorRequest: { request: 'Repair' } }, partialText: null },
          ],
          native: null,
          structured: null,
          findings: null,
        },
      }),
    )
    const request = required(
      buildRecord({
        version: 1,
        ...scope,
        recordId: 'empty-request',
        runId: 'run',
        operationId: 'empty-request-op',
        kind: 'fix-request',
        payload: {
          requestContributionId: requestContribution.recordId,
          originalSpec: base.prepared.causeContext.effective.own,
          existingReviewId: null,
          scope: 'all findings',
          landing: false,
        },
      }),
    )
    const rootPayload = graph.root.payload
    const root = required(
      buildRecord({
        ...graph.root,
        payload: {
          rootAttemptId: rootPayload.rootAttemptId,
          candidateGitSHA: rootPayload.candidateGitSHA,
          inputFormat: rootPayload.inputFormat,
          input: rootPayload.input,
          actionInputDigest: rootPayload.actionInputDigest,
          slots: rootPayload.slots,
          stage: 'initial',
          purpose: 'correction',
          requestId: request.recordId,
          policy: rootPayload.policy,
        },
      }),
    )
    const synthesis = required(
      parseRecord({ ...graph.synthesis, payload: { ...graph.synthesis.payload, purpose: 'correction' } }),
    )
    const decision = required(parseRecord({ ...graph.decision, payload: { ...graph.decision.payload, judgment } }))
    const contribution = required(
      parseRecord({
        ...graph.synthesisContribution,
        payload: {
          ...graph.synthesisContribution.payload,
          structured: judgment,
          rawAttempts: [
            submission({
              id: `child-${graph.synthesisContribution.recordId}`,
              structuredOutput: { status: 'valid', data: judgment },
            }),
          ],
        },
      }),
    )
    if (decision.kind !== 'decision') throw new Error('expected correction decision')
    const binding = base.graph.history.operations.find((item) => item.record?.kind === 'workflow-binding')
    if (!binding) throw new Error('authenticated binding missing')
    const replacements = new Map([root, synthesis, decision, contribution].map((record) => [record.recordId, record]))
    const target = {
      ...graph.history,
      operations: [
        binding,
        operation(requestContribution),
        operation(request),
        ...graph.history.operations.flatMap((item) => {
          if (item.recordId === graph.review.recordId) return []
          const replacement = item.recordId === null ? undefined : replacements.get(item.recordId)
          return [replacement ? operation(replacement) : item]
        }),
      ],
    }
    const product = consumer(base.origin, target)
    const result = await persistCauseDispositions(
      { ...base.prepared, capture: { kind: 'action', input: synthesisActionCapture(decision, [target, base.origin]) } },
      { kind: 'decision', decision },
      identity,
      product.dispositionStore,
    )
    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) throw new Error('empty correction persistence refused')
    expect(result.value.pending).toBe(true)
    expect(product.saved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({
            subject: expect.objectContaining({
              kind: 'rule-error',
              diagnostic: expect.objectContaining({ code: 'unknown-reference' }),
            }),
            outcome: expect.objectContaining({ state: 'pending-blocking' }),
          }),
        }),
      ]),
    )
    const readback = await product.dispositionStore.read()
    if (!readback.ok) throw new Error('readback unavailable')
    expect(holds(readback.value)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'cause-adjudication-required' })]),
    )
  })
})
