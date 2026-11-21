import { afterEach, describe, expect, it, vi } from 'vitest'
import { claimStartActivation, startDispatch } from '../../roxabi/feature-start-executions.ts'
import { consultableAgentRoot } from '../../testing/protocol-retention.unit.ts'
import { batch, bridgeHarness, cleanupFixtureActions, fixtureAction } from '../../testing/review-runtime-support.ts'
import type { NativeBatchCallbacks, NativeExecutionObservation, NativeStop } from '../review-runtime/contracts.ts'

const root = consultableAgentRoot()
afterEach(cleanupFixtureActions)

function callbacks() {
  const stops: NativeStop[] = []
  const completed = vi.fn()
  const value: NativeBatchCallbacks = {
    onComplete: completed,
    onStop: async (_reason, _result, stop) => {
      stops.push(stop)
    },
  }
  return { value, stops, completed }
}

describe('runtime cessation and late-stop safety regressions', () => {
  it('keeps a START non-resolvable after an admitted child launches a named bash service', async () => {
    const h = bridgeHarness()
    const prepared = batch(['slot-a'])
    const ref = {
      scope: { repository: 'acme/app', target: 'acme/app#42' },
      kind: 'action-receipt' as const,
      recordId: 'service-start',
    }
    expect(claimStartActivation(ref, prepared.operationId)).toBe(true)
    prepared.tasks.tasks[0].agent = 'R-review-fix-apply'
    prepared.tasks.tasks[0].action = fixtureAction('slot-a', 'R-review-fix-apply')
    const observed = callbacks()
    h.controller.activate(prepared, observed.value)
    expect(await h.admitBatch(prepared, 'service-call', root)).toBe(true)
    const child = await h.admitChild(prepared, 'slot-a', 'slot-a', { root, skipRootCall: true })
    const command = { command: 'sleep 600', name: 'test-service' }
    await child.call('bash', 'service-bash', command)
    await child.result('bash', 'service-bash', command, {
      content: [],
      details: { service: { name: 'test-service', state: 'running' } },
      isError: false,
    })
    await h.settleBatch({
      toolCallId: 'service-call',
      errors: [],
      results: [
        {
          id: 'slot-a',
          index: 0,
          agent: 'R-review-fix-apply',
          exitCode: 1,
        },
      ],
    })
    expect(observed.stops).toHaveLength(1)
    expect(startDispatch(ref)).toEqual({ kind: 'activated', operationId: prepared.operationId })
  })

  it('withholds otherwise valid child results when host integrity fails before a late stop', async () => {
    const h = bridgeHarness()
    const prepared = batch(['slot-a'])
    const observed = callbacks()
    h.controller.activate(prepared, observed.value)
    expect(await h.admitBatch(prepared, 'integrity-call', root)).toBe(true)
    await h.admitChild(prepared, 'slot-a', 'slot-a', { root, skipRootCall: true })
    await h.yieldChild('slot-a', { findings: [] })
    const stopping = h.controller.stopOwned(prepared, 'pause')
    const hostErrors = ['native task mask drifted during execution']
    await h.settleBatch({
      toolCallId: 'integrity-call',
      errors: hostErrors,
      hostErrors,
      results: [
        {
          id: 'slot-a',
          index: 0,
          agent: 'R-review-adversarial',
          exitCode: 0,
          structuredOutput: { status: 'valid', data: { findings: [] } },
        },
      ],
    } as NativeExecutionObservation)
    await stopping
    expect(observed.completed).not.toHaveBeenCalled()
    expect(observed.stops).toEqual([{ kind: 'withheld', cause: 'execution-errors' }])
  })

  it('does not interpret SDK yield-error self-abort plus a late host stop as a host interruption', async () => {
    const h = bridgeHarness()
    const prepared = batch(['slot-a'])
    const observed = callbacks()
    h.controller.activate(prepared, observed.value)
    expect(await h.admitBatch(prepared, 'yield-call', root)).toBe(true)
    const child = await h.admitChild(prepared, 'slot-a', 'slot-a', { root, skipRootCall: true })
    const error = 'cannot finish this task'
    await child.call('yield', 'yield-error', { error })
    await child.result('yield', 'yield-error', { error }, { content: [], details: {}, isError: false })
    const yieldItems = [{ status: 'aborted', error }]
    // SingleResult.aborted in the SDK includes an aborted yield item; it is not host provenance.
    const sdkResult = {
      id: 'slot-a',
      index: 0,
      agent: 'R-review-adversarial',
      exitCode: 1,
      extractedToolData: { yield: yieldItems },
      aborted: yieldItems.some((item) => item.status === 'aborted'),
    }
    const stopping = h.controller.stopOwned(prepared, 'late-pause')
    await h.settleBatch({ toolCallId: 'yield-call', errors: ['child aborted'], results: [sdkResult] })
    await stopping
    expect(observed.stops).toHaveLength(1)
    expect(observed.stops[0]).not.toMatchObject({ kind: 'interrupted' })
  })

  it.each(['held', 'done'] as const)(
    'does not leave the native status claiming a decision is pending after %s delivery',
    async (decision) => {
      const h = bridgeHarness()
      const prepared = batch(['slot-a'])
      const status: string[] = []
      let delivered: string | null = null
      h.controller.activate(prepared, {
        onComplete: async () => undefined,
        onSettled: async () => {
          delivered = decision
        },
        onStop: async () => {
          throw new Error('unexpected stop')
        },
      })
      expect(await h.admitBatch(prepared, `status-${decision}`, root)).toBe(true)
      h.controller.bindCommunication({
        status: (line) => status.push(line),
        message() {},
        async retain() {
          return 'local://retained'
        },
      })
      await h.admitChild(prepared, 'slot-a', 'slot-a', { root, skipRootCall: true })
      await h.yieldChild('slot-a', { findings: [] })
      await h.settleBatch({
        toolCallId: `status-${decision}`,
        errors: [],
        results: [
          {
            id: 'slot-a',
            index: 0,
            agent: 'R-review-adversarial',
            exitCode: 0,
            structuredOutput: { status: 'valid', data: { findings: [] } },
          },
        ],
      })
      expect(delivered).toBe(decision)
      expect(status.at(-1)).toEqual(expect.any(String))
      expect(status.at(-1)).not.toMatch(/workflow decision pending/i)
      expect(status.at(-1)).not.toMatch(/workflow.*success/i)
    },
  )

  it('does not replace known completed native output with an uncertain outcome after a late stop', async () => {
    const h = bridgeHarness()
    const prepared = batch(['slot-a'])
    const status: string[] = []
    let stopping: Promise<void> | undefined
    let published = false
    h.controller.activate(prepared, {
      onComplete: async () => {
        published = true
        stopping = h.controller.stopOwned(prepared, 'late-pause')
      },
      onStop: async () => undefined,
    })
    expect(await h.admitBatch(prepared, 'late-complete', root)).toBe(true)
    h.controller.bindCommunication({
      status: (line) => status.push(line),
      message() {},
      async retain() {
        return 'local://retained'
      },
    })
    await h.admitChild(prepared, 'slot-a', 'slot-a', { root, skipRootCall: true })
    await h.yieldChild('slot-a', { findings: [] })
    await h.settleBatch({
      toolCallId: 'late-complete',
      errors: [],
      results: [
        {
          id: 'slot-a',
          index: 0,
          agent: 'R-review-adversarial',
          exitCode: 0,
          structuredOutput: { status: 'valid', data: { findings: [] } },
        },
      ],
    })
    await stopping
    expect(published).toBe(true)
    expect(status.at(-1)).toEqual(expect.any(String))
    expect(status.at(-1)).not.toMatch(/execution outcome uncertain/i)
    expect(status.at(-1)).not.toMatch(/workflow.*success/i)
  })
})
