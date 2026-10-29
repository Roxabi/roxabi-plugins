import { afterEach, describe, expect, it, vi } from 'vitest'
import { consultableAgentRoot } from '../../testing/protocol-retention.unit.ts'
import { batch, bridgeHarness, cleanupFixtureActions } from '../../testing/review-runtime-support.ts'
import { groundCapturedChildren } from '../review-runtime/child-capture.ts'
import { createActiveBatch } from '../review-runtime/state.ts'

const root = consultableAgentRoot()

afterEach(() => {
  cleanupFixtureActions()
})

const tip = 'a'.repeat(40)

function completingResult(id: string) {
  return {
    toolCallId: 'task-call',
    errors: [],
    results: [
      {
        index: 0,
        id,
        agent: 'R-review-adversarial',
        exitCode: 0,
        structuredOutput: { status: 'valid', data: { findings: [] } },
      },
    ],
  }
}

describe('native communication red probes', () => {
  it('shows the first active batch in a fresh root session without a prior result', async () => {
    const harness = bridgeHarness()
    const setStatus = vi.fn()
    const context = {
      ...root,
      sessionManager: { getSessionId: () => 'fresh-root' },
      ui: { setStatus },
    }
    await harness.emitBridge('session_start', { type: 'session_start' }, context)
    const prepared = batch(['slot-a'])
    harness.controller.activate(prepared, {
      onComplete: async () => undefined,
      onStop: async () => undefined,
    })
    expect(setStatus).toHaveBeenCalledWith('omp-build', `omp-build: native batch ${prepared.operationId} active`)
    expect(harness.messages).toEqual([])
  })

  it('replaces active status when a consumer receives a failed batch', async () => {
    const harness = bridgeHarness()
    const setStatus = vi.fn()
    const statusRoot = { ...root, ui: { setStatus } }
    const prepared = batch(['slot-a'])
    const onStop = vi.fn(async () => undefined)
    await harness.emitBridge('session_start', { type: 'session_start' }, statusRoot)
    harness.controller.activate(prepared, { onComplete: async () => undefined, onStop })
    await harness.admitBatch(prepared, 'task-call', statusRoot)
    await harness.settleBatch({ ...completingResult('slot-a'), errors: ['execution failed'] })
    expect(onStop).toHaveBeenCalledWith(
      'native-execution-failed:execution failed',
      expect.objectContaining({ complete: false }),
    )
    expect(setStatus).toHaveBeenLastCalledWith('omp-build', `omp-build: native batch ${prepared.operationId} stopped`)
  })

  it('replaces active status when the current batch is stopped', async () => {
    const harness = bridgeHarness()
    const setStatus = vi.fn()
    const statusRoot = { ...root, ui: { setStatus } }
    const prepared = batch(['slot-a'])
    const onStop = vi.fn(async () => undefined)
    await harness.emitBridge('session_start', { type: 'session_start' }, statusRoot)
    harness.controller.activate(prepared, { onComplete: async () => undefined, onStop })
    await harness.controller.stopOwned(prepared, 'owner-stop')
    expect(onStop).toHaveBeenCalledWith('owner-stop', expect.objectContaining({ complete: false }))
    expect(setStatus).toHaveBeenLastCalledWith('omp-build', `omp-build: native batch ${prepared.operationId} stopped`)
  })

  it('does not let an older stopped generation replace a newer active status', async () => {
    const harness = bridgeHarness()
    const setStatus = vi.fn()
    const statusRoot = { ...root, ui: { setStatus } }
    const prepared = batch(['slot-a'])
    const gate = Promise.withResolvers<void>()
    let entered = false
    await harness.emitBridge('session_start', { type: 'session_start' }, statusRoot)
    harness.controller.activate(prepared, {
      onComplete: async () => undefined,
      onStop: async () => {
        entered = true
        await gate.promise
      },
    })
    const stopping = harness.controller.stopOwned(prepared, 'owner-stop')
    await vi.waitFor(() => expect(entered).toBe(true))
    harness.controller.activate(prepared, { onComplete: async () => undefined, onStop: async () => undefined })
    gate.resolve()
    await stopping
    expect(setStatus).toHaveBeenLastCalledWith('omp-build', `omp-build: native batch ${prepared.operationId} active`)
  })

  it('does not publish an old terminal status after the root session changes', async () => {
    const harness = bridgeHarness()
    const setStatus = vi.fn()
    const statusRoot = { ...root, sessionManager: { getSessionId: () => 'first' }, ui: { setStatus } }
    const prepared = batch(['slot-a'])
    const gate = Promise.withResolvers<void>()
    let entered = false
    await harness.emitBridge('session_start', { type: 'session_start' }, statusRoot)
    harness.controller.activate(prepared, {
      onComplete: async () => undefined,
      onStop: async () => {
        entered = true
        await gate.promise
      },
    })
    const stopping = harness.controller.stopOwned(prepared, 'owner-stop')
    await vi.waitFor(() => expect(entered).toBe(true))
    await harness.emitBridge(
      'session_start',
      { type: 'session_start' },
      {
        ...statusRoot,
        sessionManager: { getSessionId: () => 'second' },
      },
    )
    gate.resolve()
    await stopping
    expect(setStatus).toHaveBeenCalledTimes(1)
  })

  it('replaces active status even when the stop callback throws', async () => {
    const harness = bridgeHarness()
    const setStatus = vi.fn()
    const statusRoot = { ...root, ui: { setStatus } }
    const prepared = batch(['slot-a'])
    await harness.emitBridge('session_start', { type: 'session_start' }, statusRoot)
    harness.controller.activate(prepared, {
      onComplete: async () => undefined,
      onStop: async () => {
        throw new Error('stop failed')
      },
    })
    await expect(harness.controller.stopOwned(prepared, 'owner-stop')).rejects.toThrow('stop failed')
    expect(setStatus).toHaveBeenLastCalledWith('omp-build', `omp-build: native batch ${prepared.operationId} stopped`)
  })

  it('waits for exceptional settlement stop handling before presenting the terminal status', async () => {
    const harness = bridgeHarness()
    const setStatus = vi.fn()
    const statusRoot = { ...root, ui: { setStatus } }
    const prepared = batch(['slot-a'])
    const gate = Promise.withResolvers<void>()
    let stops = 0
    await harness.emitBridge('session_start', { type: 'session_start' }, statusRoot)
    harness.controller.activate(prepared, {
      onComplete: async () => undefined,
      onStop: async () => {
        stops++
        if (stops === 1) throw new Error('first stop failed')
        await gate.promise
      },
    })
    await harness.admitBatch(prepared, 'task-call', statusRoot)
    const pending = harness.settleBatch({ ...completingResult('slot-a'), errors: ['execution failed'] })
    await vi.waitFor(() => expect(stops).toBe(2))
    expect(setStatus).toHaveBeenLastCalledWith('omp-build', `omp-build: native batch ${prepared.operationId} active`)
    gate.resolve()
    await pending
    expect(setStatus).toHaveBeenLastCalledWith('omp-build', `omp-build: native batch ${prepared.operationId} stopped`)
  })

  it('fences the exact live batch before awaiting its registered terminal', async () => {
    const harness = bridgeHarness()
    const prepared = batch(['slot-a'])
    const gate = Promise.withResolvers<void>()
    const reasons: string[] = []
    let entered = false
    let settled = false
    let publicationsAtCallback = -1
    harness.controller.activate(prepared, {
      onComplete: async () => {
        entered = true
        publicationsAtCallback = harness.messages.length
        await gate.promise
      },
      onSettled: async () => {
        settled = true
      },
      onStop: async (reason) => {
        reasons.push(reason)
      },
    })
    await harness.admitBatch(prepared, 'task-call', root)
    await harness.admitChild(prepared, 'slot-a', 'slot-a', { root, skipRootCall: true })
    await harness.yieldChild('slot-a', { findings: [] })
    const baseline = harness.messages.length
    const pending = harness.settleBatch(completingResult('slot-a'))
    await vi.waitFor(() => expect(entered).toBe(true))
    const stop = harness.controller.stopOwned(prepared, 'owner-stop')
    gate.resolve()
    await pending
    await stop
    expect(reasons).toContain('owner-stop')
    expect(settled).toBe(false)
    expect(publicationsAtCallback).toBe(baseline)
    expect(harness.messages).toHaveLength(baseline)
  })

  it('reports native completion as status without publishing a workflow final', async () => {
    const harness = bridgeHarness()
    const prepared = batch(['slot-a'])
    const gate = Promise.withResolvers<void>()
    const setStatus = vi.fn()
    const statusRoot = { ...root, ui: { setStatus } }
    const order: string[] = []
    let publicationsAtEntry = -1
    let publicationsAtSettle = -1
    harness.controller.activate(prepared, {
      onComplete: async () => {
        order.push('onComplete')
        publicationsAtEntry = harness.messages.length
        await gate.promise
        order.push('onComplete-settled')
      },
      onSettled: async () => {
        publicationsAtSettle = harness.messages.length
        order.push('onSettled')
      },
      onStop: async () => {
        order.push('onStop')
      },
    })
    await harness.admitBatch(prepared, 'task-call', statusRoot)
    await harness.admitChild(prepared, 'slot-a', 'slot-a', { root: statusRoot, skipRootCall: true })
    await harness.yieldChild('slot-a', { findings: [] })
    const baseline = harness.messages.length
    const pending = harness.settleBatch(completingResult('slot-a'))
    await vi.waitFor(() => expect(order).toContain('onComplete'))
    expect(harness.messages).toHaveLength(baseline)
    expect(setStatus).not.toHaveBeenCalledWith('omp-build', 'omp-build: native batch native-op completed')
    gate.resolve()
    await pending
    expect(publicationsAtEntry).toBe(baseline)
    expect(publicationsAtSettle).toBe(baseline)
    expect(order).toEqual(['onComplete', 'onComplete-settled', 'onSettled'])
    expect(harness.messages).toHaveLength(baseline)
    expect(setStatus).toHaveBeenCalledWith('omp-build', 'omp-build: native batch native-op completed')
  })

  it('preserves the actual child id of an authorized mapped allocation', async () => {
    const prepared = batch(['slot-a'])
    const active = createActiveBatch(
      prepared,
      { onComplete: async () => undefined, onStop: async () => undefined },
      null,
      null,
      () => null,
    )
    active.captures.set('slot-a-2', {
      deltasByContentIndex: new Map(),
      textDeltas: [],
      pendingCalls: new Map(),
      pendingProofCalls: new Map(),
      completedProofCalls: new Map(),
      ambiguousProofCallIds: new Set(),
      pendingBashCalls: new Map(),
      completedBashCalls: new Map([
        [
          'bash-1',
          {
            toolCallId: 'bash-1',
            input: { command: 'pnpm test -- actual' },
            effectiveCwd: '/workspace',
            result: {
              content: [{ type: 'text', text: 'actual output' }],
              details: { stdout: 'actual output', stderr: '' },
            },
            exitCode: 0,
          },
        ],
      ]),
      conflictingBashCalls: [],
      ambiguousBashCallIds: new Set(),
      submissions: [],
      partialText: null,
      hostGit: new Map([
        [
          'bash-1',
          {
            start: { repository: 'acme/app', commit: tip, tree: tip },
            end: { repository: 'acme/app', commit: tip, tree: tip },
          },
        ],
      ]),
    })
    const [grounded] = await groundCapturedChildren(active, [
      {
        id: 'slot-a-2',
        expectedId: 'slot-a',
        submissions: [],
        proofEvidence: null,
        bashCalls: [],
        commandRuns: [],
        raw: null,
        partialText: null,
        structured: {
          commands: [{ toolCallId: 'bash-1', command: 'pnpm test -- actual', exitCode: 0 }],
          criteria: [
            {
              id: 'C1',
              method: 'test',
              after: {
                toolCallId: 'bash-1',
                versionClaim: {
                  code: { repository: 'acme/app', commit: tip },
                  reason: 'cited captured run',
                  references: [],
                },
              },
            },
          ],
        },
        usable: true,
        reason: null,
      },
    ])
    expect(grounded?.commandRuns).toHaveLength(1)
    expect(grounded?.nativeProvenance?.childId).toBe('slot-a-2')
    expect(grounded?.usable).toBe(true)
  })

  it('guards the bound SDK allocation without claiming an unrelated spawn', async () => {
    const harness = bridgeHarness()
    const prepared = batch(['slot-a'])
    harness.controller.activate(prepared, { onComplete: async () => undefined, onStop: async () => undefined })
    await harness.admitBatch(prepared, 'task-call', root)
    await harness.admitChild(prepared, 'slot-a', 'slot-a-2', { root, skipRootCall: true })
    const spawn = { agent: 'R-review-adversarial', invocationKind: 'task', patterns: [], spawnKey: 'slot-a-2' }
    expect(await harness.emitBridge('before_subagent_spawn', { ...spawn, agent: 'wrong-agent' }, root)).toMatchObject({
      block: true,
    })
    expect(await harness.emitBridge('before_subagent_spawn', spawn, root)).toBeUndefined()
    expect(await harness.emitBridge('before_subagent_spawn', { ...spawn, spawnKey: 'nope-2' }, root)).toBeUndefined()
  })
})
