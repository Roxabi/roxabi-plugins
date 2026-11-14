import { rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixturePreparedAction } from '../../testing/action-input-fixtures.ts'
import { consultableAgentRoot } from '../../testing/protocol-retention.unit.ts'
import {
  type BridgeHarness,
  batch,
  bridgeHarness,
  cleanupFixtureActions,
  fixtureAction,
} from '../../testing/review-runtime-support.ts'
import type {
  NativeBatch,
  NativeBatchCallbacks,
  NativeBatchResult,
  NativeExecutionObservation,
} from '../review-runtime/contracts.ts'
import { NativeBatchController } from '../review-runtime/controller.ts'

const root = consultableAgentRoot()
const directories: string[] = []
const AGENT = 'R-review-adversarial'
const negative = {
  outcome: 'missing-context',
  missing: [
    {
      locator: { kind: 'file-request', repository: 'acme/app', path: 'src/policy.ts', revisionHint: null },
      reason: 'The policy is required to assess the plan',
      targets: [],
    },
  ],
}

afterEach(() => {
  cleanupFixtureActions()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

type StopCall = [string, NativeBatchResult | null, unknown]

function recorder() {
  const onStop = vi.fn<(reason: string, result: NativeBatchResult | null, stop?: unknown) => Promise<void>>(
    async () => undefined,
  )
  const onComplete = vi.fn(async () => undefined)
  return { onStop, onComplete, callbacks: { onStop, onComplete } as NativeBatchCallbacks }
}

function stops(onStop: { mock: { calls: unknown[][] } }): unknown[] {
  return onStop.mock.calls.map((call) => (call as StopCall)[2])
}

function stoppedResult(onStop: { mock: { calls: unknown[][] } }): NativeBatchResult {
  const result = (onStop.mock.calls[0] as StopCall | undefined)?.[1]
  if (result === null || result === undefined) throw new Error('expected a stopped result')
  return result
}

function observation(results: unknown[], errors: string[] = []): NativeExecutionObservation {
  return { toolCallId: 'task-call', errors, results } as unknown as NativeExecutionObservation
}

function returned(structuredOutput?: unknown, overrides: Record<string, unknown> = {}) {
  return {
    index: 0,
    id: 'slot-a',
    agent: AGENT,
    exitCode: 0,
    ...(structuredOutput === undefined ? {} : { structuredOutput }),
    ...overrides,
  }
}

const VALID = { status: 'valid', data: { findings: [] } }
const MISMATCHED = {
  status: 'valid',
  data: {
    outcome: 'missing-context',
    missing: [{ locator: { kind: 'information-request', description: 'policy' }, reason: 'needed', targets: [] }],
  },
}

/** Activate, admit the owned call, and bind the one required child: execution stays in flight. */
async function executing(harness: BridgeHarness, prepared: NativeBatch, callbacks: NativeBatchCallbacks) {
  harness.controller.activate(prepared, callbacks)
  expect(await harness.admitBatch(prepared, 'task-call', root)).toBe(true)
  await harness.admitChild(prepared, 'slot-a', 'slot-a', { root, skipRootCall: true })
}

/** The owner stop is observed before the SDK terminal settles; settlement joins it. */
async function stopThenSettle(harness: BridgeHarness, prepared: NativeBatch, event: NativeExecutionObservation) {
  const stopping = harness.controller.stopOwned(prepared, 'pause')
  await harness.settleBatch(event)
  await stopping
}

function negativeBatch(): NativeBatch {
  const prepared = batch(['negative-action'])
  const action = fixturePreparedAction('negative-action')
  directories.push(dirname(action.snapshot.indexPath))
  prepared.operationId = 'negative-action'
  const task = prepared.tasks.tasks[0]
  if (task === undefined) throw new Error('expected a prepared task')
  task.agent = 'R-workflow-plan'
  task.action = fixtureAction('negative-action', task.agent, action.inputs)
  return prepared
}

async function negativeExecuting(harness: BridgeHarness, prepared: NativeBatch, callbacks: NativeBatchCallbacks) {
  harness.controller.activate(prepared, callbacks)
  expect(await harness.admitBatch(prepared, 'negative-call', root)).toBe(true)
  await harness.admitChild(prepared, 'negative-action', 'negative-action-2', {
    toolCallId: 'negative-call',
    root,
    skipRootCall: true,
  })
  await harness.yieldChild('negative-action-2', negative)
}

function negativeTerminal(errors: string[] = []): NativeExecutionObservation {
  return {
    toolCallId: 'negative-call',
    errors,
    results: [
      {
        index: 0,
        id: 'negative-action-2',
        agent: 'R-workflow-plan',
        exitCode: 0,
        structuredOutput: { status: 'valid', data: negative },
      },
    ],
  } as unknown as NativeExecutionObservation
}

describe('typed native stop provenance', () => {
  it('settles a host stop before dispatch as a positive not-dispatched interruption', async () => {
    const harness = bridgeHarness()
    const prepared = batch(['slot-a'])
    const { onStop, onComplete, callbacks } = recorder()
    harness.controller.activate(prepared, callbacks)

    await harness.controller.stopOwned(prepared, 'pause')

    expect(onComplete).not.toHaveBeenCalled()
    expect(stops(onStop)).toEqual([{ kind: 'interrupted', origin: 'host-stop', proof: 'not-dispatched' }])
    expect(stoppedResult(onStop).children.every((child) => !('sdkTerminal' in child))).toBe(true)
  })

  it('does not attribute an admitted SDK-aborted child to the observed host stop', async () => {
    const harness = bridgeHarness()
    const prepared = batch(['slot-a'])
    const { onStop, callbacks } = recorder()
    await executing(harness, prepared, callbacks)

    await stopThenSettle(
      harness,
      prepared,
      observation([returned(undefined, { exitCode: 1, aborted: true })], ['aborted']),
    )

    expect(stops(onStop)).toEqual([{ kind: 'unattributed', origin: 'host-stop' }])
    expect(stoppedResult(onStop).children[0]).toMatchObject({
      expectedId: 'slot-a',
      sdkTerminal: 'aborted',
      usable: false,
    })
  })

  it('keeps a returned exit-0 terminal without structured output as invalid-terminal under an observed stop', async () => {
    const harness = bridgeHarness()
    const prepared = batch(['slot-a'])
    const { onStop, callbacks } = recorder()
    await executing(harness, prepared, callbacks)

    await stopThenSettle(harness, prepared, observation([returned()]))

    expect(stops(onStop)).toEqual([{ kind: 'invalid-terminal', origin: 'host-stop' }])
    expect(stoppedResult(onStop).children[0]).toMatchObject({
      expectedId: 'slot-a',
      sdkTerminal: 'returned',
      usable: false,
      structured: null,
    })
  })

  it('never turns a completed invalid terminal into an interruption when the stop is observed afterwards', async () => {
    const harness = bridgeHarness()
    const prepared = batch(['slot-a'])
    const { onStop, callbacks } = recorder()
    await executing(harness, prepared, callbacks)
    await harness.yieldChild('slot-a', { findings: [] })

    await stopThenSettle(harness, prepared, observation([returned(MISMATCHED)]))

    expect(stops(onStop)).toEqual([{ kind: 'invalid-terminal', origin: 'host-stop' }])
    expect(stoppedResult(onStop).children[0]).toMatchObject({ sdkTerminal: 'returned', usable: false })
  })

  it('withholds a failed non-aborted terminal when execution errors are observed under a stop', async () => {
    const harness = bridgeHarness()
    const prepared = batch(['slot-a'])
    const { onStop, callbacks } = recorder()
    await executing(harness, prepared, callbacks)

    await stopThenSettle(
      harness,
      prepared,
      observation([returned(undefined, { exitCode: 1, error: 'child crashed' })], ['slot-a: child crashed']),
    )

    expect(stops(onStop)).toEqual([{ kind: 'withheld', cause: 'execution-errors' }])
    expect(stoppedResult(onStop).children[0]).toMatchObject({
      sdkTerminal: 'returned',
      usable: false,
      raw: { error: 'child crashed', exitCode: 1 },
    })
  })

  it('keeps a strictly valid returned terminal under an observed stop as completed-after-stop', async () => {
    const harness = bridgeHarness()
    const prepared = batch(['slot-a'])
    const { onStop, onComplete, callbacks } = recorder()
    await executing(harness, prepared, callbacks)
    await harness.yieldChild('slot-a', { findings: [] })

    await stopThenSettle(harness, prepared, observation([returned(VALID)]))

    expect(onComplete).not.toHaveBeenCalled()
    expect(stops(onStop)).toEqual([{ kind: 'completed-after-stop', origin: 'host-stop' }])
    expect(stoppedResult(onStop).children[0]).toMatchObject({ sdkTerminal: 'returned', usable: true })
  })

  it('never reports an authenticated valid negative raced by a stop as an interruption', async () => {
    const harness = bridgeHarness()
    const prepared = negativeBatch()
    const { onStop, onComplete, callbacks } = recorder()
    await negativeExecuting(harness, prepared, callbacks)

    const stopping = harness.controller.stopOwned(prepared, 'pause')
    await harness.settleBatch(negativeTerminal())
    await stopping

    expect(onComplete).not.toHaveBeenCalled()
    expect(stops(onStop).some((stop) => (stop as { kind?: string } | undefined)?.kind === 'interrupted')).toBe(false)
  })

  it('withholds a valid negative whose batch also failed host checks, never interrupted', async () => {
    const harness = bridgeHarness()
    const prepared = negativeBatch()
    const { onStop, callbacks } = recorder()
    await negativeExecuting(harness, prepared, callbacks)

    const stopping = harness.controller.stopOwned(prepared, 'pause')
    await harness.settleBatch(negativeTerminal(['native task mask drifted during execution']))
    await stopping

    expect(stops(onStop)).toEqual([{ kind: 'withheld', cause: 'execution-errors' }])
  })

  it('fails closed without an observed stop: aborted child is unattributed', async () => {
    const harness = bridgeHarness()
    const prepared = batch(['slot-a'])
    const { onStop, callbacks } = recorder()
    await executing(harness, prepared, callbacks)

    await harness.settleBatch(observation([returned(undefined, { exitCode: 1, aborted: true })], ['aborted']))

    expect(stops(onStop)).toEqual([{ kind: 'unattributed', origin: null }])
  })

  it('fails closed without an observed stop: invalid returned output is invalid-terminal', async () => {
    const harness = bridgeHarness()
    const prepared = batch(['slot-a'])
    const { onStop, callbacks } = recorder()
    await executing(harness, prepared, callbacks)
    await harness.yieldChild('slot-a', { findings: [] })

    await harness.settleBatch(observation([returned(MISMATCHED)]))

    expect(stops(onStop)).toEqual([{ kind: 'invalid-terminal', origin: null }])
  })

  it('withholds valid children whose batch failed host checks without any stop', async () => {
    const harness = bridgeHarness()
    const prepared = batch(['slot-a'])
    const { onStop, callbacks } = recorder()
    await executing(harness, prepared, callbacks)
    await harness.yieldChild('slot-a', { findings: [] })

    await harness.settleBatch(observation([returned(VALID)], ['native task mask drifted during execution']))

    expect(stops(onStop)).toEqual([{ kind: 'withheld', cause: 'execution-errors' }])
  })

  it('never invents a terminal for a missing required child, with or without a stop', async () => {
    const unstopped = bridgeHarness()
    const first = batch(['slot-a'])
    const quiet = recorder()
    await executing(unstopped, first, quiet.callbacks)
    await unstopped.settleBatch(observation([], ['slot-a: native child identity unavailable']))
    expect(stops(quiet.onStop)).toEqual([{ kind: 'unattributed', origin: null }])

    const stopped = bridgeHarness()
    const second = batch(['slot-a'])
    const fenced = recorder()
    await executing(stopped, second, fenced.callbacks)
    await stopThenSettle(stopped, second, observation([], ['native batch is no longer current']))
    expect(stops(fenced.onStop)).toEqual([{ kind: 'unattributed', origin: 'host-stop' }])
    expect(stoppedResult(fenced.onStop).children[0]).not.toHaveProperty('sdkTerminal')
  })

  it('records an SDK tool abort as the stop origin and keeps the first origin', async () => {
    const harness = bridgeHarness()
    const prepared = batch(['slot-a'])
    const { onStop, callbacks } = recorder()
    await executing(harness, prepared, callbacks)

    harness.controller.noteExecutionAborted(prepared)
    await stopThenSettle(
      harness,
      prepared,
      observation([returned(undefined, { exitCode: 1, aborted: true })], ['aborted']),
    )

    expect(stops(onStop)).toEqual([{ kind: 'unattributed', origin: 'sdk-abort' }])
  })

  it('does not let a missing-context stop be read as a host interruption', async () => {
    const harness = bridgeHarness()
    const prepared = negativeBatch()
    const { onStop, callbacks } = recorder()
    await negativeExecuting(harness, prepared, callbacks)

    await harness.settleBatch(negativeTerminal())

    expect(stops(onStop)).toEqual([{ kind: 'context-negative' }])
  })
})

describe('native batch ownership fences', () => {
  it('does not turn an admitted execution into a pre-admission interruption after a stop', async () => {
    const harness = bridgeHarness()
    const prepared = batch(['slot-a'])
    const { callbacks, onStop } = recorder()
    await executing(harness, prepared, callbacks)

    const stopping = harness.controller.stopOwned(prepared, 'pause')
    expect(harness.controller.active()).toBe(prepared)

    await harness.settleBatch(observation([returned(undefined, { exitCode: 1, aborted: true })], ['aborted']))
    await stopping
    expect(stops(onStop)).toEqual([{ kind: 'unattributed', origin: 'host-stop' }])
  })

  it('waits for its owned stop callback even though the active slot is released', async () => {
    const controller = new NativeBatchController()
    const prepared = batch(['slot-a'])
    const entered = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    controller.activate(prepared, {
      onComplete: async () => undefined,
      onStop: async () => {
        entered.resolve()
        await gate.promise
      },
    })

    const stopping = controller.stopOwned(prepared, 'pause')
    await entered.promise
    expect(controller.active()).toBeNull()
    let finished = false
    void stopping.then(() => {
      finished = true
    })
    await Promise.resolve()
    expect(finished).toBe(false)
    gate.resolve()
    await stopping
  })

  it('does not hold the active slot through callbacks: a successor may activate while the predecessor is still live', async () => {
    const harness = bridgeHarness()
    const first = batch(['slot-a'])
    const second = batch(['slot-b'])
    second.operationId = 'native-op-2'
    const entered = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    await executing(harness, first, {
      onComplete: async () => undefined,
      onSettled: async () => {
        harness.controller.activate(second, recorder().callbacks)
        entered.resolve()
        await gate.promise
      },
      onStop: async () => undefined,
    })
    await harness.yieldChild('slot-a', { findings: [] })

    const settling = harness.settleBatch(observation([returned(VALID)]))
    await entered.promise
    expect(harness.controller.active()).toBe(second)
    gate.resolve()
    await settling
    await harness.controller.stopOwned(second, 'cleanup')
  })

  it('detaches a batch without inventing a stop callback', () => {
    const controller = new NativeBatchController()
    const prepared = batch(['slot-a'])
    const { callbacks, onStop } = recorder()
    controller.activate(prepared, callbacks)
    controller.inactive()
    expect(controller.active()).toBeNull()
    expect(onStop).not.toHaveBeenCalled()
  })
})
