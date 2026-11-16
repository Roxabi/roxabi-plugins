import { afterEach, expect, it } from 'vitest'
import { consultableAgentRoot } from '../../testing/protocol-retention.unit.ts'
import { batch, bridgeHarness, cleanupFixtureActions } from '../../testing/review-runtime-support.ts'
import type { NativeBatchCallbacks, NativeExecutionObservation } from '../review-runtime/contracts.ts'

const root = consultableAgentRoot()
afterEach(() => cleanupFixtureActions())

async function predecessor(callbacks: NativeBatchCallbacks, context = root) {
  const harness = bridgeHarness()
  const prepared = batch(['slot-a'])
  harness.controller.activate(prepared, callbacks)
  expect(await harness.admitBatch(prepared, 'task-call', context)).toBe(true)
  await harness.admitChild(prepared, 'slot-a', 'slot-a', { root: context, skipRootCall: true })
  await harness.yieldChild('slot-a', { findings: [] })
  const observation: NativeExecutionObservation = {
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
  }
  harness.controller.prepareOwnedResult(observation, context as never)
  harness.controller.queueOwnedSettlement(observation)
  return { ...harness, prepared, observation, terminal: harness.controller.settlementFor(prepared) }
}

it('joins the predecessor callback and execution before handoff and keeps terminal pending through delivery', async () => {
  const callbackEntered = Promise.withResolvers<void>()
  const releaseCallback = Promise.withResolvers<void>()
  const handoffEntered = Promise.withResolvers<void>()
  const releaseDelivery = Promise.withResolvers<void>()
  const f = await predecessor({
    onComplete: async () => {},
    onSettled: async () => {
      callbackEntered.resolve()
      await releaseCallback.promise
      return async () => {
        handoffEntered.resolve()
        await releaseDelivery.promise
      }
    },
    onStop: async () => {},
  })
  let delivered = false
  let terminal = false
  void handoffEntered.promise.then(() => {
    delivered = true
  })
  void f.terminal.then(() => {
    terminal = true
  })
  try {
    await callbackEntered.promise
    expect(delivered).toBe(false)
    releaseCallback.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(delivered).toBe(false)
    expect(terminal).toBe(false)
    f.controller.finishExecution(f.prepared)
    await handoffEntered.promise
    expect(terminal).toBe(false)
    releaseDelivery.resolve()
    await f.terminal
    expect(terminal).toBe(true)
  } finally {
    releaseCallback.resolve()
    f.controller.finishExecution(f.prepared)
    releaseDelivery.resolve()
    await f.terminal
  }
})

it('refuses reactivation of a settled batch identity without replaying its handoff', async () => {
  let delivered = 0
  const callbacks = {
    onComplete: async () => {},
    onSettled: async () => async () => {
      delivered++
    },
    onStop: async () => {},
  }
  const f = await predecessor(callbacks)
  f.controller.finishExecution(f.prepared)
  await f.terminal
  expect(delivered).toBe(1)
  expect(() => f.controller.activate(f.prepared, callbacks)).toThrow()
  f.controller.queueOwnedSettlement(f.observation)
  expect(f.controller.settlementFor(f.prepared)).toBe(f.terminal)
  await f.terminal
  expect(delivered).toBe(1)
  const next = batch(['distinct-batch'])
  f.controller.activate(next, callbacks)
  expect(f.controller.active()).toBe(next)
  await f.controller.stopOwned(next, 'test-cleanup')
})

it('rejects the public terminal once when deferred successor delivery fails without replaying predecessor callbacks', async () => {
  const entered = Promise.withResolvers<void>()
  const delivery = Promise.withResolvers<void>()
  const failure = new Error('successor-delivery-failed')
  let delivered = 0
  let published = 0
  let completed = 0
  let stopped = 0
  const f = await predecessor({
    onChildResult: () => {
      published++
    },
    onComplete: async () => {
      completed++
    },
    onSettled: async () => async () => {
      delivered++
      entered.resolve()
      await delivery.promise
    },
    onStop: async () => {
      stopped++
    },
  })
  const rejected = expect(f.terminal).rejects.toBe(failure)
  f.controller.finishExecution(f.prepared)
  await entered.promise
  delivery.reject(failure)
  await rejected
  expect(f.controller.settlementFor(f.prepared)).toBe(f.terminal)
  f.controller.queueOwnedSettlement(f.observation)
  await expect(f.controller.settlementFor(f.prepared)).rejects.toBe(failure)
  expect({ delivered, published, completed, stopped }).toEqual({
    delivered: 1,
    published: 1,
    completed: 1,
    stopped: 0,
  })
})

it('global stop fences and joins a detached predecessor before its successor can start', async () => {
  const entered = Promise.withResolvers<void>()
  const releaseCallback = Promise.withResolvers<void>()
  let delivered = 0
  let stopped = 0
  const f = await predecessor({
    onComplete: async () => {},
    onSettled: async () => {
      entered.resolve()
      await releaseCallback.promise
      return async () => {
        delivered++
      }
    },
    onStop: async () => {
      stopped++
    },
  })
  await entered.promise
  let stopFinished = false
  const stopping = f.controller.stop('operator-stop').then(() => {
    stopFinished = true
  })
  try {
    releaseCallback.resolve()
    await Promise.resolve()
    expect(stopFinished).toBe(false)
    expect(delivered).toBe(0)
    f.controller.finishExecution(f.prepared)
    await stopping
    await f.terminal
    expect(stopFinished).toBe(true)
    expect(delivered).toBe(0)
    expect(stopped).toBe(1)
  } finally {
    releaseCallback.resolve()
    f.controller.finishExecution(f.prepared)
    await stopping
  }
})

it('global stop joins an already entered successor and propagates its terminal failure', async () => {
  const entered = Promise.withResolvers<void>()
  const delivery = Promise.withResolvers<void>()
  const failure = new Error('delivery-after-stop-failed')
  let delivered = 0
  let published = 0
  let completed = 0
  let stopped = 0
  const f = await predecessor({
    onChildResult: () => {
      published++
    },
    onComplete: async () => {
      completed++
    },
    onSettled: async () => async () => {
      delivered++
      entered.resolve()
      await delivery.promise
    },
    onStop: async () => {
      stopped++
    },
  })
  const terminalRejected = expect(f.terminal).rejects.toBe(failure)
  f.controller.finishExecution(f.prepared)
  await entered.promise
  let stopFinished = false
  const stopping = f.controller.stop('operator-stop').finally(() => {
    stopFinished = true
  })
  const stopRejected = expect(stopping).rejects.toBe(failure)
  try {
    await Promise.resolve()
    expect(stopFinished).toBe(false)
    expect(delivered).toBe(1)
    delivery.reject(failure)
    await terminalRejected
    await stopRejected
    expect(stopFinished).toBe(true)
    expect({ delivered, published, completed, stopped }).toEqual({
      delivered: 1,
      published: 1,
      completed: 1,
      stopped: 0,
    })
  } finally {
    delivery.reject(failure)
    await Promise.allSettled([f.terminal, stopping])
  }
})

it('does not deliver a successor when the predecessor is stopped before execution joins', async () => {
  const callbackEntered = Promise.withResolvers<void>()
  let delivered = false
  const f = await predecessor({
    onComplete: async () => {},
    onSettled: async () => {
      callbackEntered.resolve()
      return async () => {
        delivered = true
      }
    },
    onStop: async () => {},
  })
  await callbackEntered.promise
  const stopping = f.controller.stopOwned(f.prepared, 'operator-stop')
  f.controller.finishExecution(f.prepared)
  await stopping
  await f.terminal
  expect(delivered).toBe(false)
})

it('does not deliver a successor after the owning root session changes before handoff', async () => {
  let session = 'original'
  const context = { ...root, sessionManager: { getSessionId: () => session } }
  const callbackEntered = Promise.withResolvers<void>()
  let delivered = false
  const f = await predecessor(
    {
      onComplete: async () => {},
      onSettled: async () => {
        callbackEntered.resolve()
        return async () => {
          delivered = true
        }
      },
      onStop: async () => {},
    },
    context,
  )
  await callbackEntered.promise
  session = 'replacement'
  f.controller.finishExecution(f.prepared)
  await f.terminal
  expect(delivered).toBe(false)
})

it('retains a detached foreign batch as a live writer during predecessor handoff', async () => {
  const callbackEntered = Promise.withResolvers<void>()
  const releaseCallback = Promise.withResolvers<void>()
  const delivery = Promise.withResolvers<boolean>()
  const f = await predecessor({
    onComplete: async () => {},
    onSettled: async () => {
      callbackEntered.resolve()
      await releaseCallback.promise
      return async () => {
        delivery.resolve(f.controller.hasLiveBatchExcept((item) => item === f.prepared))
      }
    },
    onStop: async () => {},
  })
  await callbackEntered.promise
  const foreign = batch(['foreign-writer'])
  const foreignStopEntered = Promise.withResolvers<void>()
  const releaseForeign = Promise.withResolvers<void>()
  f.controller.activate(foreign, {
    onComplete: async () => {},
    onStop: async () => {
      foreignStopEntered.resolve()
      await releaseForeign.promise
    },
  })
  const stopping = f.controller.stopOwned(foreign, 'foreign-stop')
  try {
    await foreignStopEntered.promise
    releaseCallback.resolve()
    f.controller.finishExecution(f.prepared)
    expect(await delivery.promise).toBe(true)
    await f.terminal
  } finally {
    releaseCallback.resolve()
    f.controller.finishExecution(f.prepared)
    releaseForeign.resolve()
    await stopping
    await f.terminal
  }
})
