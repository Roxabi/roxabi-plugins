import { describe, expect, it, vi } from 'vitest'
import type { CanonicalRecord, DecodedHistory } from '../dist/contracts.js'
import { assessCauseHolds, buildRecord, parseRecord } from '../dist/contracts.js'
import { submission } from '../testing/record-builders.ts'
import { acceptedPullRequestReviewGraph, reviewGraph } from '../testing/record-graphs.ts'
import { observedComment, operation } from '../testing/record-history.ts'
import { roxabiWorkflowFixtures } from '../testing/roxabi-presets.ts'
import type { FixIdentity, FixRecord, PreparedFix } from './fix-contract.ts'
import { persistCauseDispositions } from './fix-disposition-execution.ts'
import type { DefaultFixWorkflow } from './fix-execution-policy.ts'
import { executeDecision, runReviewBoundFixWorkflow } from './fix-execution-runner.ts'

const original = { repository: 'Acme/app', target: 'Acme/app#12' }
const prepared = {
  causeContext: { original, effective: { own: { sourceAccepted: { scope: original } } } },
} as unknown as PreparedFix
const decision = {
  kind: 'decision',
  repository: 'Acme/app',
  target: 'Acme/app#42',
  recordId: 'decision-1',
  payload: { judgment: { causes: [] } },
} as unknown as Extract<FixRecord, { kind: 'decision' }>
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
    causeContext: { original, effective: inputs.manifest.spec.effective },
  } as PreparedFix
  return { graph, origin, prepared }
}

function consumer(origin: DecodedHistory, target: DecodedHistory) {
  let current = origin
  const saved: Extract<CanonicalRecord, { kind: 'cause-disposition' }>[] = []
  const activate = vi.fn()
  const publish = vi.fn()
  const dispositionStore = {
    read: vi.fn(async () => ({ ok: true as const, value: [current, target] })),
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
  const workflow = {
    dispositionStore,
    native: { activate },
    publisher: { publish },
    runtime: { signal: new AbortController().signal },
    readHistory: async () => target,
  } as unknown as DefaultFixWorkflow
  return { workflow, saved, activate, publish, dispositionStore }
}

describe('correction disposition ingress', () => {
  it('refuses before dispatch or publication when original history is unreadable', async () => {
    const activate = vi.fn()
    const publish = vi.fn()
    const product = {
      runtime: { signal: new AbortController().signal },
      native: { activate },
      publisher: { publish },
      dispositionStore: {
        read: vi.fn(async () => ({
          ok: false as const,
          diagnostics: [{ code: 'correction-disposition-history-unreadable', message: 'unavailable' }],
        })),
        publish: vi.fn(),
      },
      readHistory: vi.fn(),
    } as unknown as DefaultFixWorkflow
    const result = await executeDecision(prepared, decision, product, identity)
    expect(result).toEqual({ ok: false, diagnostics: ['correction-disposition-history-unreadable'] })
    expect(product.dispositionStore.read).toHaveBeenCalledWith([
      { repository: 'Acme/app', target: 'Acme/app#42' },
      original,
    ])
    expect(activate).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    expect(product.dispositionStore.publish).not.toHaveBeenCalled()
  })

  it('persists a nonblocking report on its authenticated original without dispatching a fix', async () => {
    const { graph, origin, prepared } = acceptedReview('suggestion')
    const product = consumer(origin, graph.history)
    const result = await persistCauseDispositions(
      prepared,
      { kind: 'decision', decision: graph.decision },
      identity,
      product.workflow.dispositionStore,
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
    expect(product.activate).not.toHaveBeenCalled()
    expect(product.publish).not.toHaveBeenCalled()
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
      prepared,
      { kind: 'decision', decision },
      { ...identity, nextRecordId: () => `disposition-${++sequence}` },
      product.workflow.dispositionStore,
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
    const holds = assessCauseHolds({
      uw: original,
      histories: readback.value,
      graph: { status: 'complete', root: original, nodes: [], observedAt: '2026-10-27T12:00:00.000Z' },
    })
    expect(holds).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'cause-adjudication-required' })]))
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
      base.prepared,
      { kind: 'decision', decision },
      identity,
      product.workflow.dispositionStore,
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
    expect(
      assessCauseHolds({
        uw: original,
        histories: readback.value,
        graph: { status: 'complete', root: original, nodes: [], observedAt: '2026-10-27T12:00:00.000Z' },
      }),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'cause-adjudication-required' })]))
  })

  it('refuses an unauthenticated synthesis slot without filing or applying the raw finding', async () => {
    const { graph, origin, prepared } = acceptedReview()
    // A foreign native author cannot authenticate the synthesis action slot.
    const target = {
      ...graph.history,
      operations: graph.history.operations.map((item) =>
        item.recordId === graph.synthesis.recordId ? { ...item, authority: 'foreign' as const } : item,
      ),
    }
    const product = consumer(origin, target)
    const result = await runReviewBoundFixWorkflow(prepared, graph.decision, product.workflow, identity)
    expect(result).toEqual({ ok: false, diagnostics: ['cause-source-unconfirmed'] })
    expect(product.saved).toEqual([])
    expect(product.activate).not.toHaveBeenCalled()
    expect(product.publish).not.toHaveBeenCalled()
    expect(target.operations.find((item) => item.recordId === graph.panel.recordId)?.record).toEqual(graph.panel)
    expect(graph.panel.target).not.toBe(original.target)
  })

  it('retains authenticated findings and rule errors when synthesis breaks the partition', async () => {
    const { graph, origin, prepared } = acceptedReview()
    const cause = graph.decision.payload.judgment.causes[0]
    if (cause === undefined) throw new Error('fixture cause required')
    const brokenDecision = {
      ...graph.decision,
      payload: {
        ...graph.decision.payload,
        judgment: { ...graph.decision.payload.judgment, causes: [{ ...cause, findingIds: ['unknown-finding'] }] },
      },
    }
    const brokenSynthesis = {
      ...graph.synthesisContribution,
      payload: {
        ...graph.synthesisContribution.payload,
        structured: brokenDecision.payload.judgment,
        rawAttempts: graph.synthesisContribution.payload.rawAttempts.map((attempt) => ({
          ...attempt,
          data: brokenDecision.payload.judgment,
        })),
      },
    }
    const target = {
      ...graph.history,
      operations: graph.history.operations.map((item) =>
        item.recordId === brokenDecision.recordId
          ? { ...item, record: brokenDecision }
          : item.recordId === brokenSynthesis.recordId
            ? { ...item, record: brokenSynthesis }
            : item,
      ),
    }
    const product = consumer(origin, target)
    const result = await runReviewBoundFixWorkflow(prepared, brokenDecision, product.workflow, identity)
    expect(result.ok).toBe(false)
    expect(
      product.saved.some(
        (item) =>
          item.payload.subject.kind === 'retained-finding' &&
          item.payload.subject.contribution.recordId === graph.panel.recordId &&
          item.payload.outcome.state === 'pending-blocking',
      ),
    ).toBe(true)
    expect(
      product.saved.some(
        (item) => item.payload.subject.kind === 'rule-error' && item.payload.outcome.state === 'pending-blocking',
      ),
    ).toBe(true)
    expect(
      product.saved.every((item) => item.repository === original.repository && item.target === original.target),
    ).toBe(true)
    expect(product.activate).not.toHaveBeenCalled()
    expect(product.publish).not.toHaveBeenCalled()
    expect(target.operations.find((item) => item.recordId === graph.panel.recordId)?.record).toEqual(graph.panel)
  })
})
