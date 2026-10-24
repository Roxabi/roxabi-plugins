import { describe, expect, it } from 'vitest'
import { batch, bridgeHarness, root } from '../../testing/review-runtime-support.ts'
import type { NativeChildResult } from '../review-runtime/contracts.ts'
import { NativeBatchController } from '../review-runtime/controller.ts'
import { createNativeReviewPort } from '../review-runtime/port.ts'

describe('native review bridge lifecycle', () => {
  it('starts an initial idle batch once without an agent-end resend', async () => {
    const harness = bridgeHarness()
    const prepared = batch(['slot-a'])
    const idleRoot = { ...root, isIdle: () => true }
    await harness.emitBridge('session_start', {}, idleRoot)
    const port = createNativeReviewPort(harness.native, harness.controller)
    port.activate(prepared, { onComplete: async () => undefined, onStop: async () => undefined })
    await port.announce(prepared)
    await harness.emitBridge('agent_end', { willContinue: false }, idleRoot)
    expect(harness.messages).toHaveLength(1)
    expect(harness.messages[0]).toContain('OMP_BUILD_NATIVE_BATCH:')
  })

  it('preserves an announced undelivered batch across normal settle for agent-end dispatch', async () => {
    const harness = bridgeHarness()
    const prepared = batch(['slot-a'])
    const busyRoot = { ...root, isIdle: () => false }
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
    const dispatched = await harness.emitBridge(
      'tool_call',
      { toolName: 'task', toolCallId: 'task-call', input: prepared.tasks },
      busyRoot,
    )
    expect(stopped).toBe(false)
    expect(harness.messages).toHaveLength(1)
    expect(dispatched).toBeUndefined()
  })

  it('does not infer a zero exit from an async Bash start result', async () => {
    const harness = bridgeHarness()
    const prepared = batch(['slot-a'])
    prepared.tasks.tasks[0].proofEvidence = {
      purpose: 'fix-revalidate',
      occurrence: 'restored',
      causeId: 'cause-1',
    }
    const children: NativeChildResult[] = []
    harness.controller.activate(prepared, {
      onChildResult: (child): void => {
        children.push(child)
      },
      onComplete: async () => undefined,
      onStop: async () => undefined,
    })
    await harness.emitBridge(
      'tool_call',
      { toolName: 'task', toolCallId: 'task-call', input: harness.controller.wire(prepared) },
      root,
    )
    harness.emitRaw({
      id: 'slot-a',
      event: {
        type: 'tool_execution_start',
        toolName: 'bash',
        toolCallId: 'async-proof',
        args: { command: 'bun test' },
      },
    })
    harness.emitRaw({
      id: 'slot-a',
      event: {
        type: 'tool_execution_end',
        toolName: 'bash',
        toolCallId: 'async-proof',
        isError: false,
        result: { details: { async: { state: 'running', jobId: 'job-1', type: 'bash' } } },
      },
    })
    harness.emitRaw({
      id: 'slot-a',
      event: {
        type: 'tool_execution_start',
        toolName: 'yield',
        toolCallId: 'yield-1',
        args: { data: { proofToolCallId: 'async-proof' } },
      },
    })
    await harness.emitBridge(
      'tool_result',
      {
        toolName: 'task',
        toolCallId: 'task-call',
        isError: false,
        content: [],
        details: {
          results: [
            {
              id: 'slot-a',
              index: 0,
              exitCode: 0,
              structuredOutput: { status: 'valid', data: { proofToolCallId: 'async-proof' } },
            },
          ],
        },
      },
      root,
    )
    expect(children[0]?.proofEvidence?.call?.exitCode).toBeNull()
  })

  it('retains only the structured-result-selected native proof Bash invocation and strips host metadata from the wire batch', async () => {
    const harness = bridgeHarness()
    const prepared = batch(['slot-a'])
    const cwdRoot = { ...root, cwd: '/workspace' }
    prepared.tasks.tasks[0].proofEvidence = {
      purpose: 'fix-revalidate',
      occurrence: 'restored',
      causeId: 'cause-1',
    }
    const children: NativeChildResult[] = []
    harness.controller.activate(prepared, {
      onChildResult: (child): void => {
        children.push(child)
      },
      onComplete: async () => undefined,
      onStop: async () => undefined,
    })
    const wrongBatch = await harness.emitBridge(
      'tool_call',
      { toolName: 'task', toolCallId: 'wrong-call', input: prepared.tasks },
      cwdRoot,
    )
    expect(wrongBatch).toMatchObject({ block: true })
    const wire = harness.controller.wire(prepared)
    expect(wire).not.toBeNull()
    expect(wire).not.toHaveProperty('tasks.0.proofEvidence')
    await harness.emitBridge('tool_call', { toolName: 'task', toolCallId: 'task-call', input: wire }, cwdRoot)
    for (const [toolCallId, args, result] of [
      ['setup-call', { command: 'pnpm install', cwd: '/workspace' }, { details: { exitCode: 0 } }],
      [
        'proof-call',
        { command: 'pnpm test -- actual' },
        { content: [{ type: 'text', text: 'proof output' }], details: { wallTimeMs: undefined } },
      ],
    ] as const) {
      harness.emitRaw({ id: 'slot-a', event: { type: 'tool_execution_start', toolName: 'bash', toolCallId, args } })
      harness.emitRaw({
        id: 'slot-a',
        event: { type: 'tool_execution_end', toolName: 'bash', toolCallId, isError: false, result },
      })
    }
    harness.emitRaw({
      id: 'slot-a',
      event: {
        type: 'tool_execution_start',
        toolName: 'yield',
        toolCallId: 'yield-1',
        args: { data: { proofToolCallId: 'proof-call' } },
      },
    })
    await harness.emitBridge(
      'tool_result',
      {
        toolName: 'task',
        toolCallId: 'task-call',
        isError: false,
        content: [],
        details: {
          results: [
            {
              id: 'slot-a',
              index: 0,
              exitCode: 0,
              structuredOutput: { status: 'valid', data: { proofToolCallId: 'proof-call' } },
            },
          ],
        },
      },
      cwdRoot,
    )
    expect(children).toMatchObject([
      {
        proofEvidence: {
          purpose: 'fix-revalidate',
          occurrence: 'restored',
          causeId: 'cause-1',
          call: {
            toolCallId: 'proof-call',
            input: { command: 'pnpm test -- actual' },
            effectiveCwd: '/workspace',
            result: { content: [{ type: 'text', text: 'proof output' }], details: {} },
            exitCode: 0,
          },
        },
      },
    ])
  })

  it('resolves omitted, relative, and absolute proof cwd against native session cwd', async () => {
    const harness = bridgeHarness()
    const prepared = batch(['omitted', 'relative', 'absolute'])
    const sessionCwd = '/native/session'
    const cases = [
      ['omitted', { command: 'pnpm test omitted' }, sessionCwd],
      ['relative', { command: 'pnpm test relative', cwd: '.' }, sessionCwd],
      ['absolute', { command: 'pnpm test absolute', cwd: '/prepared/repo' }, '/prepared/repo'],
    ] as const
    for (const [name] of cases) {
      const task = prepared.tasks.tasks.find((candidate) => candidate.name === name)
      if (task) task.proofEvidence = { purpose: 'fix-revalidate', occurrence: 'restored', causeId: name }
    }
    const children: NativeChildResult[] = []
    harness.controller.activate(prepared, {
      onChildResult: (child): void => {
        children.push(child)
      },
      onComplete: async () => undefined,
      onStop: async () => undefined,
    })
    const sessionRoot = { ...root, cwd: sessionCwd }
    await harness.emitBridge(
      'tool_call',
      { toolName: 'task', toolCallId: 'task-call', input: harness.controller.wire(prepared) },
      sessionRoot,
    )
    for (const [name, args] of cases) {
      harness.emitRaw({
        id: name,
        event: { type: 'tool_execution_start', toolName: 'bash', toolCallId: `${name}-proof`, args },
      })
      harness.emitRaw({
        id: name,
        event: {
          type: 'tool_execution_end',
          toolName: 'bash',
          toolCallId: `${name}-proof`,
          isError: false,
          result: { details: { exitCode: 0 } },
        },
      })
      harness.emitRaw({
        id: name,
        event: {
          type: 'tool_execution_start',
          toolName: 'yield',
          toolCallId: `${name}-yield`,
          args: { data: { proofToolCallId: `${name}-proof` } },
        },
      })
    }
    await harness.emitBridge(
      'tool_result',
      {
        toolName: 'task',
        toolCallId: 'task-call',
        isError: false,
        content: [],
        details: {
          results: cases.map(([name], index) => ({
            index,
            id: name,
            exitCode: 0,
            structuredOutput: { status: 'valid', data: { proofToolCallId: `${name}-proof` } },
          })),
        },
      },
      sessionRoot,
    )
    expect(children.map((child) => child.proofEvidence?.call)).toEqual(
      cases.map(([name, args, effectiveCwd]) => ({
        toolCallId: `${name}-proof`,
        input: args,
        effectiveCwd,
        result: { details: { exitCode: 0 } },
        exitCode: 0,
      })),
    )
  })

  it('does not publish an unknown or duplicate structured proof reference', async () => {
    const harness = bridgeHarness()
    const prepared = batch(['slot-a'])
    prepared.tasks.tasks[0].proofEvidence = {
      purpose: 'fix-falsify',
      occurrence: 'perturbed',
      causeId: 'cause-1',
    }
    const children: NativeChildResult[] = []
    harness.controller.activate(prepared, {
      onChildResult: (child): void => {
        children.push(child)
      },
      onComplete: async () => undefined,
      onStop: async () => undefined,
    })
    const cwdRoot = { ...root, cwd: '/workspace' }
    const factData = {
      facts: [
        {
          guardId: 'guard-1',
          removed: true,
          intendedScenario: 'expected failure',
          proofFailed: true,
          proofToolCallId: 'duplicate-proof',
          proofUnavailableReason: null,
        },
      ],
      skippedReason: null,
      commands: [],
    }
    await harness.emitBridge(
      'tool_call',
      { toolName: 'task', toolCallId: 'task-call', input: harness.controller.wire(prepared) },
      cwdRoot,
    )
    for (const result of [{ details: { exitCode: 1 } }, { details: { exitCode: 1 } }]) {
      harness.emitRaw({
        id: 'slot-a',
        event: {
          type: 'tool_execution_start',
          toolName: 'bash',
          toolCallId: 'duplicate-proof',
          args: { command: 'pnpm test' },
        },
      })
      harness.emitRaw({
        id: 'slot-a',
        event: { type: 'tool_execution_end', toolName: 'bash', toolCallId: 'duplicate-proof', isError: false, result },
      })
    }
    harness.emitRaw({
      id: 'slot-a',
      event: { type: 'tool_execution_start', toolName: 'yield', toolCallId: 'yield-1', args: { data: factData } },
    })
    await harness.emitBridge(
      'tool_result',
      {
        toolName: 'task',
        toolCallId: 'task-call',
        isError: false,
        content: [],
        details: {
          results: [{ index: 0, id: 'slot-a', exitCode: 0, structuredOutput: { status: 'valid', data: factData } }],
        },
      },
      cwdRoot,
    )
    expect(children[0]?.proofEvidence).toMatchObject({ guardId: 'guard-1', call: null })
  })

  it('completes only when the final native structured value matches the final captured yield', async () => {
    const harness = bridgeHarness()
    const prepared = batch(['slot-a'])
    let completed = false
    harness.controller.activate(prepared, {
      onComplete: async (result) => {
        completed = result.complete
      },
      onStop: async () => undefined,
    })
    await harness.emitBridge('tool_call', { toolName: 'task', toolCallId: 'task-call', input: prepared.tasks }, root)
    harness.emitRaw({
      id: 'slot-a',
      event: {
        type: 'tool_execution_start',
        toolName: 'yield',
        toolCallId: 'yield-1',
        args: { data: { findings: [] } },
      },
    })
    await harness.emitBridge(
      'tool_result',
      {
        toolName: 'task',
        toolCallId: 'task-call',
        isError: false,
        content: [],
        details: {
          results: [
            {
              index: 0,
              id: 'slot-a',
              agent: 'reviewer',
              exitCode: 0,
              structuredOutput: { status: 'valid', data: { findings: [] } },
            },
          ],
        },
      },
      root,
    )
    expect(completed).toBe(true)
  })

  it('joins an in-flight terminal archive when the owner stops the same batch', async () => {
    const harness = bridgeHarness()
    const prepared = batch(['slot-a'])
    const archiveGate = Promise.withResolvers<void>()
    harness.controller.activate(prepared, {
      onChildResult: async () => await archiveGate.promise,
      onComplete: async () => undefined,
      onStop: async () => undefined,
    })
    await harness.emitBridge('tool_call', { toolName: 'task', toolCallId: 'task-call', input: prepared.tasks }, root)
    const signalStop = harness.controller.stop('session-settle-aborted')
    let ownerStopSettled = false
    const ownerStop = harness.controller.stopOwned(prepared, 'owner-stop').then(() => {
      ownerStopSettled = true
    })
    await Promise.resolve()
    expect(ownerStopSettled).toBe(false)
    archiveGate.resolve()
    await signalStop
    await ownerStop
    expect(ownerStopSettled).toBe(true)
  })

  it('conserves an unmatched child capture when its owning batch stops', async () => {
    const harness = bridgeHarness()
    const prepared = batch(['slot-a'])
    const children: NativeChildResult[] = []
    harness.controller.activate(prepared, {
      onChildResult: (child): void => {
        children.push(child)
      },
      onComplete: async () => undefined,
      onStop: async () => undefined,
    })
    await harness.emitBridge('tool_call', { toolName: 'task', toolCallId: 'task-call', input: prepared.tasks }, root)
    harness.emitRaw({
      id: 'unlisted-child',
      event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'unlisted partial' } },
    })
    harness.emitRaw({
      id: 'unlisted-child',
      event: {
        type: 'message_update',
        assistantMessageEvent: {
          type: 'toolcall_end',
          contentIndex: 0,
          toolCall: { id: 'unlisted-yield', name: 'yield', arguments: { data: { findings: [] } } },
        },
      },
    })
    await harness.controller.stopOwned(prepared, 'owner-stopped')
    expect(children).toMatchObject([
      { expectedId: 'slot-a' },
      { id: null, expectedId: null, partialText: 'unlisted partial', submissions: [{ data: { findings: [] } }] },
    ])
  })
})

describe('native batch controller ownership fences', () => {
  it('does not confer live-batch ownership on a structural clone', async () => {
    const controller = new NativeBatchController()
    const prepared = batch(['slot-a'])
    const clone = { ...prepared, tasks: { ...prepared.tasks, tasks: [...prepared.tasks.tasks] } }
    let stopped = false
    controller.activate(prepared, {
      onComplete: async () => undefined,
      onStop: async () => {
        stopped = true
      },
    })
    await controller.stopOwned(clone, 'clone-stop')
    expect(controller.active()).toBe(prepared)
    expect(stopped).toBe(false)
    await controller.stopOwned(prepared, 'owner-stop')
    expect(stopped).toBe(true)
  })

  it('keeps the terminal fence intact when feature pause interleaves with owner stop', async () => {
    const controller = new NativeBatchController()
    const prepared = batch(['slot-a'])
    const stopGate = Promise.withResolvers<void>()
    const onStopEntered = Promise.withResolvers<void>()
    const reasons: string[] = []
    controller.activate(prepared, {
      onComplete: async () => undefined,
      onStop: async (reason) => {
        reasons.push(reason)
        onStopEntered.resolve()
        await stopGate.promise
      },
    })
    controller.markFeatureBatch(prepared)
    expect(controller.announce(prepared)).toBe(true)
    controller.inhibitFeatureContinuation()
    expect(controller.consumeFollowUp()).toBeNull()
    const first = controller.stopOwned(prepared, 'pause-terminal')
    let secondSettled = false
    const second = controller.stopOwned(prepared, 'second-owner-stop').then(() => {
      secondSettled = true
    })
    await onStopEntered.promise
    expect(secondSettled).toBe(false)
    expect(reasons).toEqual(['pause-terminal'])
    stopGate.resolve()
    await first
    await second
    expect(controller.active()).toBeNull()
    expect(reasons).toEqual(['pause-terminal'])
  })
})
