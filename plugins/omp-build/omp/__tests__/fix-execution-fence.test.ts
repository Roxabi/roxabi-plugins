import { afterEach, describe, expect, it, vi } from 'vitest'
import { admitFixBatch, FixExecutionFence } from '../../roxabi/fix-execution-fence.ts'
import { executeDecision } from '../../roxabi/fix-execution-runner.ts'
import { createExtensionApiStub } from '../../testing/extension-api-stub.ts'
import { provisionNativeRoot } from '../../testing/native-root-fixture.ts'
import { batch, cleanupFixtureActions } from '../../testing/review-runtime-support.ts'
import { createOmpFixPort, reviewControllerFor } from '../omp-controller.ts'
import { executeOwnedBatch } from '../review-runtime/batch-execution.ts'
import { captureNativeRootLifetime } from '../review-runtime/native-sdk-adapter.ts'
import { taskMaskCurrent } from '../review-runtime/task-mask-lease.ts'

afterEach(() => cleanupFixtureActions())

async function announcedCorrection(ownerCurrent: () => boolean = () => true) {
  const sent = vi.fn()
  const api = createExtensionApiStub({ sendMessage: sent })
  const ctx = {
    agent: { kind: 'main' as const, id: 'FenceTestRoot', name: 'main', depth: 0 },
    cwd: '/fixture-root',
    sessionManager: { getSessionId: () => 'fence-session' },
    isIdle: () => true,
  }
  provisionNativeRoot(ctx)
  const root = await captureNativeRootLifetime(ctx as never)
  if (!root) throw new Error('fixture root lifetime was not captured')
  const fence = new FixExecutionFence()
  // Control the owner observation while retaining the captured SDK root predicate.
  fence.bindRoot(() => root.current() && ownerCurrent(), root.lifetime)
  const port = createOmpFixPort(api, fence)
  const controller = reviewControllerFor(api)
  controller.observeRootContext(ctx as never)
  const prepared = batch(['correction'])
  port.activate(prepared, { onComplete: async () => {}, onStop: async () => {} })
  await port.announce(prepared)
  const wire = controller.wire(prepared)
  if (!wire) throw new Error('announced correction has no selector')
  expect(sent).toHaveBeenCalled()
  expect(await taskMaskCurrent(controller, prepared)).toBe(true)
  return { api, ctx, port, controller, prepared, wire, root }
}

describe('correction execution fence', () => {
  it('refuses an already announced owned tool call after sealing, before actual admission', async () => {
    const f = await announcedCorrection()
    const admission = vi.spyOn(f.controller, 'admit')
    f.port.executionFence.seal()
    await expect(
      executeOwnedBatch(f.api, f.controller, 'late-call', f.wire, undefined, f.ctx as never),
    ).rejects.toThrow('native root or action unavailable')
    expect(admission).not.toHaveBeenCalled()
    expect(f.port.executionFence.snapshot()).toMatchObject({ sealed: true, nativeEntered: false, nativeUnknown: false })
    expect(f.controller.active()).toBeNull()
  })

  it('refuses an announced batch when its owner root is lost and retains the loss fact', async () => {
    let current = true
    const f = await announcedCorrection(() => current)
    current = false
    const admission = vi.spyOn(f.controller, 'admit')
    await expect(
      executeOwnedBatch(f.api, f.controller, 'lost-root-call', f.wire, undefined, f.ctx as never),
    ).rejects.toThrow('native root or action unavailable')
    expect(admission).not.toHaveBeenCalled()
    current = true
    expect(f.port.executionFence.rootCurrent()).toBe(false)
    f.port.executionFence.seal()
    expect(f.port.executionFence.snapshot()).toMatchObject({ rootBound: true, rootLost: true, nativeEntered: false })
  })

  it('retains successful controller admission after the batch is released', async () => {
    const f = await announcedCorrection()
    expect(
      admitFixBatch(f.prepared, () => f.controller.admit(f.prepared, 'owned-call', f.ctx as never, f.root.current)),
    ).toBe(true)
    f.controller.finishExecution(f.prepared)
    await f.port.stopOwned(f.prepared, 'fixture-release')
    expect(f.controller.active()).toBeNull()
    f.port.executionFence.seal()
    expect(f.port.executionFence.snapshot()).toMatchObject({ sealed: true, nativeEntered: true, nativeUnknown: false })
  })

  it('distinguishes rejected admission from an ambiguous exceptional admission', () => {
    const rejected = new FixExecutionFence()
    const first = batch(['rejected'])
    rejected.bind(first)
    expect(admitFixBatch(first, () => false)).toBe(false)
    rejected.seal()
    expect(rejected.snapshot()).toMatchObject({ nativeEntered: false, nativeUnknown: false })

    const ambiguous = new FixExecutionFence()
    const second = batch(['ambiguous'])
    ambiguous.bind(second)
    expect(() =>
      admitFixBatch(second, () => {
        throw new Error('admission outcome unavailable')
      }),
    ).toThrow('admission outcome unavailable')
    ambiguous.seal()
    expect(ambiguous.snapshot()).toMatchObject({ nativeUnknown: true })
  })

  it('prevents a sealed decision from reaching disposition work', async () => {
    const fence = new FixExecutionFence()
    fence.seal()
    const prepared = {
      get causeContext(): never {
        throw new Error('disposition work entered')
      },
    }
    const product = { runtime: { signal: new AbortController().signal, executionFence: fence } }
    const result = await executeDecision(
      prepared as never,
      {} as never,
      product as never,
      {} as never,
      'authenticate-source',
    )
    expect(result).toEqual({ ok: false, diagnostics: ['fix-run-interrupted-cleanup-unproven'] })
    expect(fence.snapshot()).toMatchObject({ sealed: true, planEntered: false })
  })

  it('records conservative plan entry even when subsequent disposition work throws', async () => {
    const fence = new FixExecutionFence()
    const prepared = {
      get causeContext(): never {
        throw new Error('disposition boundary')
      },
    }
    const product = { runtime: { signal: new AbortController().signal, executionFence: fence } }
    await expect(
      executeDecision(prepared as never, {} as never, product as never, {} as never, 'authenticate-source'),
    ).rejects.toThrow('disposition boundary')
    fence.seal()
    expect(fence.enterPlan()).toBe(false)
    expect(fence.snapshot()).toMatchObject({ sealed: true, planEntered: true })
  })
})
