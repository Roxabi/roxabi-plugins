import { describe, expect, it, vi } from 'vitest'
import type { CanonicalRecord, DecodedHistory } from '../dist/contracts.js'
import { acceptedPullRequestReviewGraph } from '../testing/record-graphs.ts'
import { operation } from '../testing/record-history.ts'
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
      const observed = operation(item, { authority: 'accounted' })
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
