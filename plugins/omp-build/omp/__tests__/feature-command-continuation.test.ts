import { afterEach, describe, expect, it } from 'vitest'
import { consultableAgentRoot } from '../../testing/protocol-retention.unit.ts'
import { batch, bridgeHarness, cleanupFixtureActions, root } from '../../testing/review-runtime-support.ts'
import { NativeBatchController } from '../review-runtime/controller.ts'

afterEach(() => {
  cleanupFixtureActions()
})

describe('native review continuation seam', () => {
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

  it('calls onSettled once after a confirmed complete result and not from agent_end', async () => {
    const harness = bridgeHarness()
    const { controller } = harness
    const prepared = batch(['review-slot'])
    let completed = 0
    let settled = 0
    const context = consultableAgentRoot()
    controller.activate(prepared, {
      onComplete: async () => {
        completed += 1
      },
      onSettled: async () => {
        settled += 1
      },
      onStop: async () => undefined,
    })
    expect(await harness.admitBatch(prepared, 'task-call', context)).toBe(true)
    const data = { findings: [] }
    await harness.admitChild(prepared, 'review-slot', 'task-call:0', { root: context, skipRootCall: true })
    await harness.yieldChild('task-call:0', data)
    await harness.settleBatch({
      toolCallId: 'task-call',
      errors: [],
      results: [
        {
          index: 0,
          id: 'task-call:0',
          agent: 'R-review-adversarial',
          exitCode: 0,
          structuredOutput: { status: 'valid', data },
        },
      ],
    })
    expect(completed).toBe(1)
    expect(settled).toBe(1)
    await harness.emitBridge('agent_end', { willContinue: false }, context)
    expect(completed).toBe(1)
    expect(settled).toBe(1)
  })
})
