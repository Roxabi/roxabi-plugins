import { describe, expect, it, vi } from 'vitest'
import type { NativeBatchCallbacks, NativeBatchResult, NativeChildResult } from '../omp/review-runtime/contracts'
import type { PreparedReviewBatch, ReviewContext, ReviewPublisher } from './review-contract'
import { ReviewProduct } from './review-dispatch'

const context: ReviewContext = {
  operationId: 'op',
  runId: 'run',
  repository: 'acme/widgets',
  target: 'acme/widgets#1',
  candidateGitSHA: 'a'.repeat(40),
  input: null,
  subject: { kind: 'pull-request' },
}
const prepared = {
  stage: 'initial',
  rootAttemptId: 'attempt',
  inventory: {},
  batch: { operationId: 'op', tasks: { context: '', tasks: [] } },
} as PreparedReviewBatch

const child = {
  id: 'native-spec',
  expectedId: 'spec',
  submissions: [],
  proofEvidence: null,
  raw: { status: 'completed' },
  partialText: null,
  structured: { findings: [] },
  usable: true,
  reason: null,
} as NativeChildResult

describe('ReviewProduct', () => {
  it('persists the actual raw child before completion receives its conserved contribution', async () => {
    const order: string[] = []
    let callbacks: NativeBatchCallbacks | undefined
    const publisher: ReviewPublisher = {
      authorize: async () => ({ ok: true }),
      publishInventory: async () => {
        order.push('inventory')
        return { ok: true }
      },
      publishRawContribution: async (_prepared, rawChild) => {
        order.push('raw')
        expect(rawChild).toBe(child)
        return { id: 'contribution', child: rawChild }
      },
      completeStage: async (_prepared, result, contributions) => {
        order.push('complete')
        expect(result.complete).toBe(true)
        expect(contributions).toEqual([{ id: 'contribution', child }])
        return null
      },
      publishRequiredStop: async () => ({ ok: true }),
      stop: vi.fn(),
    }
    const product = new ReviewProduct(
      {
        activate: (_batch, value) => {
          order.push('activate')
          callbacks = value
        },
        inactive: vi.fn(),
        announce: async () => {},
      },
      publisher,
    )

    await product.preparePullRequestReview(context, prepared)
    expect(order).toEqual(['inventory', 'activate'])
    if (callbacks === undefined) throw new Error('review dispatch did not activate callbacks')
    await callbacks.onChildResult?.(child)
    await callbacks.onComplete(
      {
        batch: prepared.batch,
        children: [child],
        raw: {},
        complete: true,
      } as NativeBatchResult,
      () => true,
    )
    expect(order).toEqual(['inventory', 'activate', 'raw', 'complete'])
  })

  it('does not publish or activate when dispatch authority is withdrawn during authorization', async () => {
    let canDispatch = true
    const authorization = Promise.withResolvers<{ ok: true }>()
    const publishInventory = vi.fn(async () => ({ ok: true as const }))
    const activate = vi.fn()
    const product = new ReviewProduct(
      { activate, inactive: vi.fn(), announce: async () => {} },
      {
        authorize: async () => authorization.promise,
        publishInventory,
        publishRawContribution: async (_prepared, rawChild) => ({ id: 'unused', child: rawChild }),
        completeStage: async () => null,
        publishRequiredStop: async () => ({ ok: true }),
        stop: vi.fn(),
      },
      { canDispatch: () => canDispatch },
    )

    const dispatch = product.preparePullRequestReview(context, prepared)
    await Promise.resolve()
    canDispatch = false
    authorization.resolve({ ok: true })

    await expect(dispatch).rejects.toThrow('review-dispatch-refused:fix-run-active')
    expect(publishInventory).not.toHaveBeenCalled()
    expect(activate).not.toHaveBeenCalled()
  })

  it('reports the scoped continuation refusal without publishing an inventory', async () => {
    const publishInventory = vi.fn(async () => ({ ok: true as const }))
    const product = new ReviewProduct(
      { activate: vi.fn(), inactive: vi.fn(), announce: async () => {} },
      {
        authorize: async () => ({ ok: true }),
        publishInventory,
        publishRawContribution: async (_prepared, rawChild) => ({ id: 'unused', child: rawChild }),
        completeStage: async () => null,
        publishRequiredStop: async () => ({ ok: true }),
        stop: vi.fn(),
      },
      { canDispatch: () => false, refusalReason: () => 'continuation-inhibited' },
    )

    await expect(product.preparePullRequestReview(context, prepared)).rejects.toThrow(
      'review-dispatch-refused:continuation-inhibited',
    )
    expect(publishInventory).not.toHaveBeenCalled()
  })

  it('conserves a published inventory but refuses activation when authority changes during publication', async () => {
    let canDispatch = true
    const activate = vi.fn()
    const announce = vi.fn(async () => {})
    const publishInventory = vi.fn(async () => {
      canDispatch = false
      return { ok: true as const }
    })
    const product = new ReviewProduct(
      { activate, inactive: vi.fn(), announce },
      {
        authorize: async () => ({ ok: true }),
        publishInventory,
        publishRawContribution: async (_prepared, rawChild) => ({ id: 'unused', child: rawChild }),
        completeStage: async () => null,
        publishRequiredStop: async () => ({ ok: true }),
        stop: vi.fn(),
      },
      { canDispatch: () => canDispatch },
    )

    await expect(product.preparePullRequestReview(context, prepared)).rejects.toThrow(
      'review-dispatch-refused:fix-run-active',
    )
    expect(publishInventory).toHaveBeenCalledOnce()
    expect(activate).not.toHaveBeenCalled()
    expect(announce).not.toHaveBeenCalled()
  })
})
