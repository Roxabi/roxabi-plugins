import { afterEach, describe, expect, it } from 'vitest'
import type { FeatureCommandHost } from '../../roxabi/feature-contract.ts'
import { runInstalledFeatureCommand } from '../../roxabi/feature-entry.ts'
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
    expect(controller.releaseFeatureContinuation(controller.featureContinuationEpoch())).toBe(true)
    expect(controller.featureContinuationInhibited()).toBe(false)
    expect(controller.announce(next)).toBe(true)
  })

  it('newer stop / ABA vetoes a stale generation-bound unlock', () => {
    const controller = new NativeBatchController()
    controller.inhibitFeatureContinuation()
    const staleEpoch = controller.featureContinuationEpoch()
    controller.inhibitFeatureContinuation()
    expect(controller.featureContinuationEpoch()).toBeGreaterThan(staleEpoch)
    expect(controller.releaseFeatureContinuation(staleEpoch)).toBe(false)
    expect(controller.featureContinuationInhibited()).toBe(true)

    const successor = batch('aba-successor')
    controller.activate(successor, { onComplete: async () => undefined, onStop: async () => undefined })
    controller.markFeatureBatch(successor)
    expect(controller.announce(successor)).toBe(false)

    const currentEpoch = controller.featureContinuationEpoch()
    expect(controller.releaseFeatureContinuation(currentEpoch)).toBe(true)
    expect(controller.featureContinuationInhibited()).toBe(false)
    expect(controller.announce(successor)).toBe(true)
  })

  it('same-session F5: after abandon latch, new runnable admits without a manual unlock', async () => {
    const controller = new NativeBatchController()
    controller.inhibitFeatureContinuation()
    const ingressNativeEpoch = controller.featureContinuationEpoch()
    const successor = batch('f5-new-successor')
    const sent: string[] = []
    const host: FeatureCommandHost = {
      key: {},
      cwd: '/workspace',
      principal: false,
      workflow: {
        async continueFeature() {
          return { kind: 'review', pr: 99 }
        },
        async consumeWatchExit() {
          throw new Error('unexpected watch')
        },
        async publishFeatureNativeResult() {
          throw new Error('unexpected publication')
        },
        async requestFeatureSessionPause() {
          throw new Error('unexpected pause')
        },
      },
      native: {
        activate() {},
        inactive() {},
        async stopOwned() {},
        async announce() {
          throw new Error('unexpected announce')
        },
      },
      async send(text) {
        sent.push(text)
      },
      status() {},
      async startFraming() {
        throw new Error('unexpected framing')
      },
      inhibitFeatureContinuation: () => controller.inhibitFeatureContinuation(),
      releaseFeatureContinuation: () => controller.releaseFeatureContinuation(ingressNativeEpoch),
      featureContinuationInhibited: () => controller.featureContinuationInhibited(),
      markFeatureBatch: (value) => controller.markFeatureBatch(value),
      async startReview() {},
      async exec() {
        throw new Error('unexpected exec')
      },
    }
    expect(controller.featureContinuationInhibited()).toBe(true)
    await runInstalledFeatureCommand('new 42', host)
    expect(controller.featureContinuationInhibited()).toBe(false)
    controller.activate(successor, { onComplete: async () => undefined, onStop: async () => undefined })
    controller.markFeatureBatch(successor)
    expect(controller.announce(successor)).toBe(true)
    expect(sent).toEqual([])
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
