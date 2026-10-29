import { rmSync, writeFileSync } from 'node:fs'
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
import type { NativeBatch, NativeBatchResult, NativeChildResult } from '../review-runtime/contracts.ts'

const root = consultableAgentRoot()
const directories: string[] = []
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

function firstTask(prepared: NativeBatch) {
  const task = prepared.tasks.tasks[0]
  if (task === undefined) throw new Error('expected a prepared task')
  return task
}

function preparedBatch(actionId: string): NativeBatch {
  const prepared = batch([actionId])
  const action = fixturePreparedAction(actionId)
  directories.push(dirname(action.snapshot.indexPath))
  prepared.operationId = actionId
  const task = firstTask(prepared)
  task.agent = 'R-workflow-plan'
  task.action = fixtureAction(actionId, task.agent, action.inputs)
  return prepared
}

async function admit(harness: BridgeHarness, prepared: NativeBatch, callId: string): Promise<void> {
  await harness.emitBridge(
    'tool_call',
    {
      toolName: 'task',
      toolCallId: callId,
      input: harness.controller.wire(prepared),
    },
    root,
  )
}

function terminal(callId: string, childId: string) {
  return {
    toolName: 'task',
    toolCallId: callId,
    isError: false,
    content: [],
    details: {
      results: [
        {
          index: 0,
          id: childId,
          agent: 'R-workflow-plan',
          exitCode: 0,
          structuredOutput: { status: 'valid', data: negative },
        },
      ],
    },
  }
}

async function capture(
  harness: BridgeHarness,
  prepared: NativeBatch,
  logicalName: string,
  childId: string,
  callId: string,
): Promise<void> {
  await harness.admitChild(prepared, logicalName, childId, { toolCallId: callId, root, skipRootCall: true })
  await harness.yieldChild(childId, negative)
}

describe('native runtime missing-context settlement', () => {
  it('retains a matched negative with its exact host binding and stops once without positive callbacks', async () => {
    const harness = bridgeHarness()
    const prepared = preparedBatch('negative-action')
    const retained: NativeChildResult[] = []
    const onComplete = vi.fn()
    const onSettled = vi.fn()
    const onStop = vi.fn()
    harness.controller.activate(prepared, {
      onChildResult: (child) => {
        retained.push(child)
      },
      onComplete,
      onSettled,
      onStop,
    })
    await admit(harness, prepared, 'negative-call')
    await capture(harness, prepared, 'negative-action', 'negative-action-2', 'negative-call')
    const event = terminal('negative-call', 'negative-action-2')
    await harness.emitBridgeAndSettle('tool_result', event, root)
    await harness.emitBridgeAndSettle('tool_result', event, root)

    expect(onStop).toHaveBeenCalledTimes(1)
    expect(onComplete).not.toHaveBeenCalled()
    expect(onSettled).not.toHaveBeenCalled()
    expect(retained).toHaveLength(1)
    expect(retained[0]).toMatchObject({
      id: 'negative-action-2',
      expectedId: 'negative-action',
      usable: true,
      structured: negative,
      contextBlock: {
        missing: negative.missing,
        action: { actionId: 'negative-action', inputs: firstTask(prepared).action.inputs },
      },
    })
    const [reason, result] = onStop.mock.calls[0] as [string, NativeBatchResult]
    expect(reason).toBe('action-context-missing')
    expect(result.complete).toBe(true)
    expect(result.children).toEqual(retained)
  })

  it('retains a valid plan-review negative alongside an invalid sibling without claiming a complete batch', async () => {
    const harness = bridgeHarness()
    const prepared = preparedBatch('review-first')
    const sibling = preparedBatch('review-second')
    firstTask(prepared).agent = 'R-workflow-plan-architect'
    firstTask(prepared).action = fixtureAction(
      'review-first',
      firstTask(prepared).agent,
      firstTask(prepared).action.inputs,
    )
    const siblingTask = firstTask(sibling)
    siblingTask.agent = 'R-workflow-plan-adversarial'
    siblingTask.action = fixtureAction('review-second', siblingTask.agent, siblingTask.action.inputs)
    prepared.tasks.tasks.push(siblingTask)
    const retained: NativeChildResult[] = []
    const onComplete = vi.fn()
    const onSettled = vi.fn()
    const onStop = vi.fn()
    harness.controller.activate(prepared, {
      onChildResult: (child) => {
        retained.push(child)
      },
      onComplete,
      onSettled,
      onStop,
    })
    await admit(harness, prepared, 'review-call')
    await capture(harness, prepared, 'review-first', 'review-first-2', 'review-call')
    await harness.admitChild(prepared, 'review-second', 'review-second-2', {
      toolCallId: 'review-call',
      root,
      skipRootCall: true,
    })
    await harness.emitBridgeAndSettle(
      'tool_result',
      {
        toolName: 'task',
        toolCallId: 'review-call',
        isError: false,
        content: [],
        details: {
          results: [
            {
              index: 0,
              id: 'review-first-2',
              agent: 'R-workflow-plan-architect',
              exitCode: 0,
              structuredOutput: { status: 'valid', data: negative },
            },
            {
              index: 1,
              id: 'review-second-2',
              agent: 'R-workflow-plan-adversarial',
              exitCode: 0,
              structuredOutput: { status: 'invalid' },
            },
          ],
        },
      },
      root,
    )

    expect(onStop).toHaveBeenCalledTimes(1)
    const [reason, result] = onStop.mock.calls[0] as [string, NativeBatchResult]
    expect(reason).toBe('action-context-missing')
    expect(result.complete).toBe(false)
    expect(retained).toHaveLength(2)
    expect(retained[0]).toMatchObject({
      id: 'review-first-2',
      expectedId: 'review-first',
      usable: true,
      structured: negative,
      contextBlock: {
        missing: negative.missing,
        action: { actionId: 'review-first', inputs: firstTask(prepared).action.inputs },
      },
    })
    expect(retained[1]).toMatchObject({ id: 'review-second-2', expectedId: 'review-second', usable: false })
    expect(retained[1]?.contextBlock).toBeUndefined()
    expect(result.children).toEqual(retained)
    expect(onComplete).not.toHaveBeenCalled()
    expect(onSettled).not.toHaveBeenCalled()
  })

  it.each(['session-switch', 'inhibit-only'] as const)(
    'keeps context publication scoped to onStop and handles %s while it is suspended',
    async (interruption) => {
      const harness = bridgeHarness()
      const prepared = preparedBatch(`guard-${interruption}`)
      const entered = Promise.withResolvers<NativeBatchResult>()
      const release = Promise.withResolvers<void>()
      const onComplete = vi.fn()
      const onSettled = vi.fn()
      const onStop = vi.fn(async (_reason: string, result: NativeBatchResult | null) => {
        if (result === null) throw new Error('expected negative result')
        entered.resolve(result)
        await release.promise
      })
      harness.controller.activate(prepared, { onComplete, onSettled, onStop })
      harness.controller.markFeatureBatch(prepared)
      await admit(harness, prepared, 'guard-call')
      const childId = `guard-${interruption}-2`
      await capture(harness, prepared, `guard-${interruption}`, childId, 'guard-call')
      const settlement = harness.emitBridgeAndSettle('tool_result', terminal('guard-call', childId), root)
      const result = await entered.promise
      const child = result.children[0]
      if (child === undefined) throw new Error('expected negative child')
      expect(result.canPublishContext?.()).toBe(true)
      expect(child.canPublishContext?.()).toBe(true)

      let switched: Promise<unknown> | undefined
      if (interruption === 'session-switch') {
        switched = harness.emitBridge('session_switch', {}, root)
        expect(result.canPublishContext?.()).toBe(false)
        expect(child.canPublishContext?.()).toBe(false)
      } else {
        harness.controller.inhibitFeatureContinuation()
        expect(result.canPublishContext?.()).toBe(true)
        expect(child.canPublishContext?.()).toBe(true)
      }
      release.resolve()
      await settlement
      await switched
      expect(result.canPublishContext?.()).toBe(false)
      expect(child.canPublishContext?.()).toBe(false)
      expect(onStop).toHaveBeenCalledTimes(1)
      expect(onComplete).not.toHaveBeenCalled()
      expect(onSettled).not.toHaveBeenCalled()
    },
  )

  it('does not let a late old result advance a freshly admitted action', async () => {
    const harness = bridgeHarness()
    const old = preparedBatch('old-action')
    const oldStop = vi.fn()
    harness.controller.activate(old, { onComplete: vi.fn(), onStop: oldStop })
    await admit(harness, old, 'old-call')
    await capture(harness, old, 'old-action', 'old-action-2', 'old-call')
    const oldResult = terminal('old-call', 'old-action-2')
    await harness.emitBridgeAndSettle('tool_result', oldResult, root)
    expect(oldStop).toHaveBeenCalledTimes(1)

    const fresh = preparedBatch('fresh-action')
    const freshStop = vi.fn()
    const freshComplete = vi.fn()
    const freshSettled = vi.fn()
    const retained: NativeChildResult[] = []
    harness.controller.activate(fresh, {
      onChildResult: (child) => {
        retained.push(child)
      },
      onComplete: freshComplete,
      onSettled: freshSettled,
      onStop: freshStop,
    })
    await admit(harness, fresh, 'fresh-call')
    await harness.emitBridgeAndSettle('tool_result', oldResult, root)
    expect(freshStop).not.toHaveBeenCalled()
    expect(freshComplete).not.toHaveBeenCalled()
    expect(freshSettled).not.toHaveBeenCalled()
    expect(retained).toEqual([])
    await capture(harness, fresh, 'fresh-action', 'fresh-action-2', 'fresh-call')
    await harness.emitBridgeAndSettle('tool_result', terminal('fresh-call', 'fresh-action-2'), root)
    expect(freshStop).toHaveBeenCalledTimes(1)
    expect(freshStop.mock.calls[0]?.[0]).toBe('action-context-missing')
    expect(retained[0]?.contextBlock?.action).toEqual({
      actionId: 'fresh-action',
      inputs: firstTask(fresh).action.inputs,
    })
    expect(freshComplete).not.toHaveBeenCalled()
    expect(freshSettled).not.toHaveBeenCalled()
  })

  it('prioritizes mutated snapshot integrity failure over a matched negative', async () => {
    const harness = bridgeHarness()
    const prepared = preparedBatch('mutated-action')
    const retained: NativeChildResult[] = []
    const onComplete = vi.fn()
    const onSettled = vi.fn()
    const onStop = vi.fn()
    harness.controller.activate(prepared, {
      onChildResult: (child) => {
        retained.push(child)
      },
      onComplete,
      onSettled,
      onStop,
    })
    await admit(harness, prepared, 'mutated-call')
    await capture(harness, prepared, 'mutated-action', 'mutated-action-2', 'mutated-call')
    writeFileSync(firstTask(prepared).action.snapshot.indexPath, 'changed after sealing')
    await harness.emitBridgeAndSettle('tool_result', terminal('mutated-call', 'mutated-action-2'), root)

    expect(onStop).toHaveBeenCalledTimes(1)
    const [reason, result] = onStop.mock.calls[0] as [string, NativeBatchResult]
    expect(reason).toMatch(/^action-integrity-failed:/)
    expect(result.complete).toBe(false)
    expect(retained).toHaveLength(1)
    expect(retained[0]).toMatchObject({ structured: negative, usable: false })
    expect(retained[0]?.contextBlock).toBeUndefined()
    expect(result.children).toEqual(retained)
    expect(onComplete).not.toHaveBeenCalled()
    expect(onSettled).not.toHaveBeenCalled()
  })
})
