import { afterEach, describe, expect, it, vi } from 'vitest'
import { consultableAgentRoot } from '../../testing/protocol-retention.unit.ts'
import {
  type BridgeHarness,
  batch,
  bridgeHarness,
  cleanupFixtureActions,
} from '../../testing/review-runtime-support.ts'
import { createNativeReviewPort } from '../review-runtime/port.ts'

const root = consultableAgentRoot()
type StopMode = 'normal' | 'aborted' | 'switch' | 'abort-after-stop'

async function stopDuringPublication(
  mode: StopMode,
  harness: BridgeHarness,
  busyRoot: typeof root,
  release: () => void,
): Promise<void> {
  const signal = new AbortController()
  if (mode === 'aborted') signal.abort()
  const stop = harness.emitBridge('session_stop', { signal: signal.signal }, busyRoot)
  if (mode === 'normal' || mode === 'abort-after-stop') await stop
  if (mode === 'normal') {
    await harness.emitBridge('agent_end', { willContinue: false }, busyRoot)
    expect(harness.messages).toEqual([])
  }
  if (mode === 'abort-after-stop') signal.abort()
  const switched = mode === 'switch' ? harness.emitBridge('session_switch', {}, busyRoot) : null
  release()
  await stop
  if (switched) await switched
}

afterEach(() => {
  cleanupFixtureActions()
})

describe('native review bridge stop and dispatch', () => {
  it('starts an initial idle batch once without an agent-end resend', async () => {
    const harness = bridgeHarness()
    const prepared = batch(['slot-a'])
    const model = { id: 'fixture-model', provider: 'fixture-provider' }
    const idleRoot = {
      ...root,
      cwd: '/fixture-root',
      sessionManager: { getSessionId: () => 'fixture-idle-session' },
      model,
      models: { resolve: () => model, current: () => model },
      isIdle: () => true,
    }
    await harness.emitBridge('session_start', {}, idleRoot)
    const port = createNativeReviewPort(harness.native, harness.controller)
    port.activate(prepared, { onComplete: async () => undefined, onStop: async () => undefined })
    await port.announce(prepared)
    await harness.emitBridge('agent_end', { willContinue: false }, idleRoot)
    expect(harness.messages).toHaveLength(2)
    expect(harness.messages[0]).toContain('OMP_BUILD_NATIVE_BATCH:')
    expect(harness.messages[1]).toBe('display:false triggerTurn:true')
  })

  it('preserves an announced undelivered batch across normal settle for agent-end dispatch', async () => {
    const harness = bridgeHarness()
    const prepared = batch(['slot-a'])
    const model = { id: 'fixture-model', provider: 'fixture-provider' }
    const busyRoot = {
      ...root,
      cwd: '/fixture-root',
      sessionManager: { getSessionId: () => 'fixture-busy-session' },
      model,
      models: { resolve: () => model, current: () => model },
      isIdle: () => false,
    }
    let stopped = false
    await harness.emitBridge('session_start', {}, busyRoot)
    const port = createNativeReviewPort(harness.native, harness.controller)
    port.activate(prepared, {
      onComplete: async () => undefined,
      onStop: async () => {
        stopped = true
      },
    })
    await port.announce(prepared)
    await harness.emitBridge('session_stop', { signal: new AbortController().signal }, busyRoot)
    await harness.emitBridge('agent_end', { willContinue: false }, busyRoot)
    const dispatched = await harness.admitBatch(prepared, 'task-call', busyRoot)
    expect(stopped).toBe(false)
    expect(harness.messages).toEqual([
      expect.stringContaining('OMP_BUILD_NATIVE_BATCH:'),
      'display:false triggerTurn:true',
    ])
    expect(dispatched).toBe(true)
  })

  it('resets the late-wake marker for a new turn and preserves an undelivered announcement', async () => {
    const harness = bridgeHarness()
    const prepared = batch(['slot-a'])
    const busyRoot = { ...root, isIdle: () => false }
    const port = createNativeReviewPort(harness.native, harness.controller)
    await harness.emitBridge('session_start', {}, busyRoot)
    await harness.emitBridge('agent_end', { willContinue: false }, busyRoot)
    await harness.emitBridge('agent_start', {}, busyRoot)
    let stopped = false
    port.activate(prepared, {
      onComplete: async () => undefined,
      onStop: async () => {
        stopped = true
      },
    })
    await port.announce(prepared)
    await harness.emitBridge('session_stop', { signal: new AbortController().signal }, busyRoot)
    expect(stopped).toBe(false)
    expect(harness.messages).toEqual([])
    await harness.emitBridge('agent_end', { willContinue: false }, busyRoot)
    expect(harness.messages).toEqual([
      expect.stringContaining('OMP_BUILD_NATIVE_BATCH:'),
      'display:false triggerTurn:true',
    ])
  })

  it.each(['normal', 'aborted', 'switch', 'abort-after-stop'] as const)(
    'preserves settlement authority only for a %s stop while publication is pending',
    async (mode) => {
      const harness = bridgeHarness()
      const sendMessage = vi.spyOn(harness.native, 'sendMessage')
      const prepared = batch(['slot-a'])
      const next = batch(['slot-b'])
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const completed = Promise.withResolvers<void>()
      const stopped = Promise.withResolvers<string>()
      const port = createNativeReviewPort(harness.native, harness.controller)
      const busyRoot = { ...root, isIdle: () => false }
      await harness.emitBridge('session_start', {}, busyRoot)
      port.activate(prepared, {
        onChildResult: async () => {
          entered.resolve()
          await release.promise
        },
        onComplete: async (result, canContinue) => {
          expect(result.complete).toBe(true)
          if (canContinue()) {
            port.activate(next, { onComplete: async () => undefined, onStop: async () => undefined })
            await port.announce(next)
          }
          completed.resolve()
        },
        onStop: async (reason) => stopped.resolve(reason),
      })
      await harness.admitChild(prepared, 'slot-a', 'slot-a', { root: busyRoot })
      await harness.yieldChild('slot-a', { findings: [] })
      harness.controller.queueOwnedSettlement({
        toolCallId: 'task-call',
        errors: [],
        results: [
          {
            index: 0,
            id: 'slot-a',
            agent: 'R-review-adversarial',
            exitCode: 0,
            structuredOutput: { status: 'valid', data: { findings: [] } },
          },
        ],
      })
      harness.controller.finishExecution(prepared)
      await entered.promise
      await stopDuringPublication(mode, harness, busyRoot, release.resolve)
      if (mode === 'normal') {
        await completed.promise
        expect(sendMessage).toHaveBeenCalledWith(
          expect.objectContaining({ content: expect.stringContaining('OMP_BUILD_NATIVE_BATCH:') }),
          { triggerTurn: true, deliverAs: 'nextTurn' },
        )
        expect(harness.messages).toEqual([
          expect.stringContaining('OMP_BUILD_NATIVE_BATCH:'),
          'display:false triggerTurn:true',
        ])
      } else {
        expect(await stopped.promise).toBe(mode === 'switch' ? 'session-switched' : 'session-settle-aborted')
        expect(harness.controller.active()).toBeNull()
      }
    },
  )

  it('does not let an old stop signal cancel a successor batch', async () => {
    const harness = bridgeHarness()
    const prepared = batch(['slot-a'])
    const next = batch(['slot-b'])
    const publicationEntered = Promise.withResolvers<void>()
    const publicationRelease = Promise.withResolvers<void>()
    const successorActivated = Promise.withResolvers<void>()
    const completionRelease = Promise.withResolvers<void>()
    const oldStopped = Promise.withResolvers<string>()
    let successorStopped = false
    const busyRoot = { ...root, isIdle: () => false }
    const port = createNativeReviewPort(harness.native, harness.controller)
    await harness.emitBridge('session_start', {}, busyRoot)
    port.activate(prepared, {
      onChildResult: async () => {
        publicationEntered.resolve()
        await publicationRelease.promise
      },
      onComplete: async () => {
        port.activate(next, {
          onComplete: async () => undefined,
          onStop: async () => {
            successorStopped = true
          },
        })
        successorActivated.resolve()
        await completionRelease.promise
      },
      onStop: async (reason) => oldStopped.resolve(reason),
    })
    await harness.admitChild(prepared, 'slot-a', 'slot-a', { root: busyRoot })
    await harness.yieldChild('slot-a', { findings: [] })
    harness.controller.queueOwnedSettlement({
      toolCallId: 'task-call',
      errors: [],
      results: [
        {
          index: 0,
          id: 'slot-a',
          agent: 'R-review-adversarial',
          exitCode: 0,
          structuredOutput: { status: 'valid', data: { findings: [] } },
        },
      ],
    })
    harness.controller.finishExecution(prepared)
    await publicationEntered.promise
    const signal = new AbortController()
    await harness.emitBridge('session_stop', { signal: signal.signal }, busyRoot)
    publicationRelease.resolve()
    await successorActivated.promise
    signal.abort()
    completionRelease.resolve()
    expect(await oldStopped.promise).toBe('session-settle-aborted')
    expect(successorStopped).toBe(false)
    expect(harness.controller.active()).toBe(next)
  })
})
