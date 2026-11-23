import { afterEach, expect, it } from 'vitest'
import { consultableAgentRoot } from '../../testing/protocol-retention.unit.ts'
import { batch, bridgeHarness, cleanupFixtureActions } from '../../testing/review-runtime-support.ts'
import type { NativeBatchCallbacks, NativeExecutionObservation } from '../review-runtime/contracts.ts'

const root = consultableAgentRoot()
afterEach(() => cleanupFixtureActions())

async function predecessor(
  callbacks: NativeBatchCallbacks,
  context = root,
  harness = bridgeHarness(),
  slot = 'slot-a',
) {
  const prepared = batch([slot])
  const call = `task-call-${slot}`
  harness.controller.activate(prepared, callbacks)
  expect(await harness.admitBatch(prepared, call, context)).toBe(true)
  await harness.admitChild(prepared, slot, slot, { root: context, skipRootCall: true })
  await harness.yieldChild(slot, { findings: [] })
  const observation: NativeExecutionObservation = {
    toolCallId: call,
    errors: [],
    results: [
      {
        index: 0,
        id: slot,
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

it('global stop joins a detached predecessor blocked in onComplete and preserves its failure', async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const failure = new Error('completion-publication-failed')
  let stopped = false
  let selected = false
  const f = await predecessor({
    onComplete: async () => {
      entered.resolve()
      await release.promise
      throw failure
    },
    onSettled: async () => {
      selected = true
    },
    onStop: async () => {},
  })
  const terminalResult = f.terminal.then(
    () => undefined,
    (error: unknown) => error,
  )
  await entered.promise
  expect(f.controller.active()).toBeNull()
  f.controller.finishExecution(f.prepared)
  const stopping = f.controller.stop('operator-stop').finally(() => {
    stopped = true
  })
  const stopResult = stopping.then(
    () => undefined,
    (error: unknown) => error,
  )
  try {
    const nextTurn = Promise.withResolvers<void>()
    setImmediate(nextTurn.resolve)
    await nextTurn.promise
    expect(stopped).toBe(false)
    release.resolve()
    expect(await terminalResult).toBe(failure)
    expect(await stopResult).toBe(failure)
    expect(selected).toBe(false)
  } finally {
    release.resolve()
    await Promise.allSettled([f.terminal, stopping])
  }
})

it('global stop joins every detached predecessor before reporting a callback failure', async () => {
  const firstEntered = Promise.withResolvers<void>()
  const secondEntered = Promise.withResolvers<void>()
  const releaseFirst = Promise.withResolvers<void>()
  const releaseSecond = Promise.withResolvers<void>()
  const failure = new Error('first-predecessor-failed')
  const harness = bridgeHarness()
  const first = await predecessor(
    {
      onComplete: async () => {},
      onSettled: async () => {
        firstEntered.resolve()
        await releaseFirst.promise
        throw failure
      },
      onStop: async () => {},
    },
    root,
    harness,
    'slot-first',
  )
  const firstResult = first.terminal.then(
    () => undefined,
    (error: unknown) => error,
  )
  await firstEntered.promise
  first.controller.finishExecution(first.prepared)
  const second = await predecessor(
    {
      onComplete: async () => {},
      onSettled: async () => {
        secondEntered.resolve()
        await releaseSecond.promise
      },
      onStop: async () => {},
    },
    root,
    harness,
    'slot-second',
  )
  await secondEntered.promise
  second.controller.finishExecution(second.prepared)
  let stopped = false
  const stopping = harness.controller.stop('operator-stop').finally(() => {
    stopped = true
  })
  const stopResult = stopping.then(
    () => undefined,
    (error: unknown) => error,
  )
  try {
    releaseFirst.resolve()
    expect(await firstResult).toBe(failure)
    const nextTurn = Promise.withResolvers<void>()
    setImmediate(nextTurn.resolve)
    await nextTurn.promise
    expect(stopped).toBe(false)
    releaseSecond.resolve()
    await second.terminal
    expect(await stopResult).toBe(failure)
  } finally {
    releaseFirst.resolve()
    releaseSecond.resolve()
    await Promise.allSettled([first.terminal, second.terminal, stopping])
  }
})

it('global stop waits for a detached predecessor selecting a successor and preserves its callback failure', async () => {
  const entered = Promise.withResolvers<void>()
  const releaseCallback = Promise.withResolvers<void>()
  const failure = new Error('predecessor-selection-failed')
  let stopFinished = false
  const f = await predecessor({
    onComplete: async () => {},
    onSettled: async () => {
      entered.resolve()
      await releaseCallback.promise
      throw failure
    },
    onStop: async () => {},
  })
  const terminalRejected = expect(f.terminal).rejects.toBe(failure)
  await entered.promise
  expect(f.controller.active()).toBeNull()
  f.controller.finishExecution(f.prepared)
  const stopping = f.controller.stop('operator-stop').finally(() => {
    stopFinished = true
  })
  const stopResult = stopping.then(
    () => undefined,
    (error: unknown) => error,
  )
  try {
    const nextTurn = Promise.withResolvers<void>()
    setImmediate(nextTurn.resolve)
    await nextTurn.promise
    expect(stopFinished).toBe(false)
    releaseCallback.resolve()
    await terminalRejected
    expect(await stopResult).toBe(failure)
    expect(stopFinished).toBe(true)
  } finally {
    releaseCallback.resolve()
    await Promise.allSettled([f.terminal, stopping])
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
