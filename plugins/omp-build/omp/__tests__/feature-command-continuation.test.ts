import { afterEach, describe, expect, it } from 'vitest'
import {
  bridgeHarness,
  cleanupFixtureActions,
  fixtureAction,
  root as nativeRoot,
} from '../../testing/review-runtime-support.ts'
import { NativeBatchController } from '../review-runtime/controller.ts'
import { batch, root } from './feature-command-lifecycle-fixture.ts'

afterEach(() => {
  cleanupFixtureActions()
})

describe('feature continuation seam', () => {
  it('does not capture a session identity before a batch is activated', () => {
    const controller = new NativeBatchController()
    const idleRoot = {
      ...root,
      sessionManager: {
        getSessionId: () => {
          throw new Error('unexpected session identity read')
        },
      },
    }
    expect(() => controller.observeRootContext(idleRoot as never)).not.toThrow()
  })

  it('drops an undelivered feature follow-up while continuation is inhibited', () => {
    const controller = new NativeBatchController()
    const prepared = batch('held')
    controller.activate(prepared, { onComplete: async () => undefined, onStop: async () => undefined })
    controller.markFeatureBatch(prepared)
    expect(controller.announce(prepared)).toBe(true)
    controller.inhibitFeatureContinuation()
    expect(controller.consumeFollowUp()).toBeNull()
    controller.inactive()
    const next = batch('blocked')
    controller.activate(next, { onComplete: async () => undefined, onStop: async () => undefined })
    controller.markFeatureBatch(next)
    expect(controller.announce(next)).toBe(false)
    controller.releaseFeatureContinuation()
    expect(controller.featureContinuationInhibited()).toBe(false)
    expect(controller.announce(next)).toBe(true)
  })

  it('calls onSettled once after a confirmed complete result and not from agent_end', async () => {
    const harness = bridgeHarness()
    const { controller } = harness
    const retainedRoot = { ...nativeRoot, ...root }
    const prepared = batch('settled')
    const task = prepared.tasks.tasks[0]
    if (task === undefined) throw new Error('settlement fixture task is missing')
    task.agent = 'R-workflow-plan'
    task.action = fixtureAction('R-workflow-plan', 'R-workflow-plan')
    let completed = 0
    let settled = 0
    controller.observeRootContext(retainedRoot as never)
    controller.activate(prepared, {
      onComplete: async () => {
        completed += 1
      },
      onSettled: async () => {
        settled += 1
      },
      onStop: async () => undefined,
    })
    controller.announce(prepared)
    const data = {
      steps: [
        {
          id: 'step-1',
          change: 'Preserve the confirmed behavior',
          doneWhen: 'The behavior is retained',
          criterionIds: ['C1'],
          evidence: 'Exercise the behavior',
          paths: ['src/feature.ts'],
        },
      ],
      resolutions: [],
    }
    await harness.admitChild(prepared, 'R-workflow-plan', 'task-call:0', {
      toolCallId: 'task-call',
      root: retainedRoot,
    })
    await harness.yieldChild('task-call:0', data)
    await harness.settleBatch({
      toolCallId: 'task-call',
      errors: [],
      results: [
        {
          index: 0,
          id: 'task-call:0',
          agent: 'R-workflow-plan',
          exitCode: 0,
          structuredOutput: { status: 'valid', data },
        },
      ],
    })
    expect(completed).toBe(1)
    expect(settled).toBe(1)
    await harness.emitBridge('agent_end', { willContinue: false }, retainedRoot)
    expect(completed).toBe(1)
    expect(settled).toBe(1)
  })
})
