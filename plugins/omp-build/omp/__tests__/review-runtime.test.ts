import { describe, expect, it } from 'vitest'
import {
  createNativeReviewPort,
  installNativeBatchBridge,
  type NativeBatch,
  NativeBatchController,
  type NativeChildResult,
  type NativeExtension,
} from '../review-runtime'

type Handler = (...args: unknown[]) => unknown
type BridgeHarness = {
  controller: NativeBatchController
  native: NativeExtension
  messages: string[]
  emitBridge(event: string, ...args: unknown[]): Promise<unknown>
  emitRaw(value: unknown): void
}

const root = { agent: { kind: 'main', id: 'Main', name: 'main', depth: 0 } }

function bridgeHarness(): BridgeHarness {
  const handlers = new Map<string, Handler>()
  const messages: string[] = []
  let rawHandler: ((value: unknown) => void) | undefined
  const pi = {
    events: {
      on: (_event: string, handler: (value: unknown) => void) => {
        rawHandler = handler
      },
    },
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler)
    },
    sendUserMessage: async (content: string) => {
      messages.push(content)
    },
  } as unknown as NativeExtension
  const controller = new NativeBatchController()
  installNativeBatchBridge(pi, controller)
  return {
    controller,
    native: pi,
    messages,
    async emitBridge(event, ...args) {
      return await handlers.get(event)?.(...args)
    },
    emitRaw(value) {
      rawHandler?.(value)
    },
  }
}

function batch(names: readonly string[]): NativeBatch {
  return {
    operationId: 'native-op',
    tasks: {
      context: 'native bridge fixture',
      tasks: names.map((name) => ({ name, agent: 'reviewer', task: name, solutionSpace: 'fixed fixture' })),
    },
  }
}

describe('native review bridge raw-yield boundary', () => {
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

  it('binds same-profile native children by their SDK task identity rather than agent role', async () => {
    const harness = bridgeHarness()
    const prepared = batch(['chunk-1', 'chunk-2'])
    for (const task of prepared.tasks.tasks) task.agent = 'R-review'
    harness.controller.activate(prepared, {
      onComplete: async () => undefined,
      onStop: async () => undefined,
    })
    await harness.emitBridge(
      'tool_call',
      { toolName: 'task', toolCallId: 'task-call', input: harness.controller.wire(prepared) },
      root,
    )

    expect(
      await harness.emitBridge(
        'before_subagent_spawn',
        {
          agent: 'R-review',
          invocationKind: 'task',
          patterns: [],
          spawnKey: 'chunk-1',
        },
        root,
      ),
    ).toBeUndefined()
    expect(
      await harness.emitBridge(
        'before_subagent_spawn',
        {
          agent: 'R-review',
          invocationKind: 'task',
          patterns: [],
          spawnKey: 'chunk-2',
        },
        root,
      ),
    ).toBeUndefined()
    expect(
      await harness.emitBridge(
        'before_subagent_spawn',
        {
          agent: 'R-review',
          invocationKind: 'task',
          patterns: [],
          spawnKey: 'chunk-2',
        },
        root,
      ),
    ).toMatchObject({ block: true })
    expect(
      await harness.emitBridge(
        'before_subagent_spawn',
        {
          agent: 'R-review',
          invocationKind: 'task',
          patterns: [],
          spawnKey: 'unprepared',
        },
        root,
      ),
    ).toMatchObject({ block: true })
  })

  it('associates a logical spawn hook with its allocated terminal child ID', async () => {
    const harness = bridgeHarness()
    const prepared = batch(['slot-a'])
    let completed = false
    harness.controller.activate(prepared, {
      onComplete: async (result) => {
        completed = result.complete
      },
      onStop: async () => undefined,
    })
    await harness.emitBridge(
      'tool_call',
      { toolName: 'task', toolCallId: 'task-call', input: harness.controller.wire(prepared) },
      root,
    )
    expect(
      await harness.emitBridge(
        'before_subagent_spawn',
        {
          agent: 'reviewer',
          invocationKind: 'task',
          patterns: [],
          spawnKey: 'slot-a',
        },
        root,
      ),
    ).toBeUndefined()
    harness.emitRaw({
      id: 'slot-a-2',
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
              id: 'slot-a-2',
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

  it('binds terminal children by their public result index while retaining allocated IDs', async () => {
    const harness = bridgeHarness()
    const prepared = batch(['slot-a', 'slot-b'])
    const children: NativeChildResult[] = []
    let completed = false
    harness.controller.activate(prepared, {
      onChildResult: (child) => {
        children.push(child)
      },
      onComplete: async (result) => {
        completed = result.complete
      },
      onStop: async () => undefined,
    })
    await harness.emitBridge(
      'tool_call',
      { toolName: 'task', toolCallId: 'task-call', input: harness.controller.wire(prepared) },
      root,
    )
    for (const id of ['allocated-a', 'allocated-b']) {
      harness.emitRaw({
        id,
        event: {
          type: 'tool_execution_start',
          toolName: 'yield',
          toolCallId: `${id}-yield`,
          args: { data: { findings: [] } },
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
          results: [
            {
              index: 1,
              id: 'allocated-b',
              agent: 'reviewer',
              exitCode: 0,
              structuredOutput: { status: 'valid', data: { findings: [] } },
            },
            {
              index: 0,
              id: 'allocated-a',
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
    expect(children.map(({ expectedId, id }) => ({ expectedId, id }))).toEqual([
      { expectedId: 'slot-a', id: 'allocated-a' },
      { expectedId: 'slot-b', id: 'allocated-b' },
    ])
  })

  it('retains unvalidated data from a schema-rejected yield', async () => {
    const harness = bridgeHarness()
    const prepared = batch(['slot-a'])
    const attempts: NativeChildResult[] = []
    let stopReason: string | undefined
    harness.controller.activate(prepared, {
      onChildResult: (child) => {
        attempts.push(child)
      },
      onComplete: async () => undefined,
      onStop: async (reason) => {
        stopReason = reason
      },
    })
    await harness.emitBridge('tool_call', { toolName: 'task', toolCallId: 'task-call', input: prepared.tasks }, root)

    harness.emitRaw({
      id: 'slot-a',
      event: {
        type: 'tool_execution_start',
        toolName: 'yield',
        toolCallId: 'yield-1',
        args: { data: { findings: [{ description: 'extractable despite schema rejection' }] } },
      },
    })
    harness.emitRaw({
      id: 'slot-a',
      event: { type: 'tool_execution_end', toolName: 'yield', toolCallId: 'yield-1', isError: true },
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
            { index: 0, id: 'slot-a', agent: 'reviewer', exitCode: 0, structuredOutput: { status: 'invalid' } },
          ],
        },
      },
      root,
    )

    expect(stopReason).toBe('structured-output-not-valid')
    expect(attempts).toMatchObject([
      {
        submissions: [{ data: { findings: [{ description: 'extractable despite schema rejection' }] } }],
      },
    ])
  })

  it('does not reuse content-index deltas and flushes an unexecuted yield on terminal failure', async () => {
    const harness = bridgeHarness()
    const prepared = batch(['slot-a'])
    const attempts: NativeChildResult[] = []
    harness.controller.activate(prepared, {
      onChildResult: (child) => {
        attempts.push(child)
      },
      onComplete: async () => undefined,
      onStop: async () => undefined,
    })
    await harness.emitBridge('tool_call', { toolName: 'task', toolCallId: 'task-call', input: prepared.tasks }, root)

    harness.emitRaw({ id: 'slot-a', event: { type: 'message_start', message: { role: 'assistant' } } })
    harness.emitRaw({
      id: 'slot-a',
      event: {
        type: 'message_update',
        assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: 'stale-' },
      },
    })
    harness.emitRaw({ id: 'slot-a', event: { type: 'message_end', message: { role: 'assistant', content: [] } } })
    harness.emitRaw({ id: 'slot-a', event: { type: 'message_start', message: { role: 'assistant' } } })
    harness.emitRaw({
      id: 'slot-a',
      event: {
        type: 'message_update',
        assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: 'fresh-' },
      },
    })
    harness.emitRaw({
      id: 'slot-a',
      event: {
        type: 'message_update',
        assistantMessageEvent: {
          type: 'toolcall_end',
          contentIndex: 0,
          toolCall: {
            id: 'yield-unexecuted',
            name: 'yield',
            arguments: { data: { findings: [{ description: 'retained pending yield' }] } },
          },
        },
      },
    })
    await harness.emitBridge(
      'tool_result',
      {
        toolName: 'task',
        toolCallId: 'task-call',
        isError: false,
        content: [],
        details: { results: [{ index: 0, id: 'slot-a', exitCode: 0, structuredOutput: { status: 'invalid' } }] },
      },
      root,
    )

    expect(attempts).toMatchObject([
      {
        submissions: [
          {
            data: { findings: [{ description: 'retained pending yield' }] },
            raw: { argumentText: 'fresh-' },
          },
        ],
      },
    ])
  })

  it('flushes pending yield evidence and partial assistant text as an unbound incomplete capture on session stop', async () => {
    const harness = bridgeHarness()
    const prepared = batch(['slot-a'])
    const attempts: NativeChildResult[] = []
    let stoppedIncomplete = false
    harness.controller.activate(prepared, {
      onChildResult: (child) => {
        attempts.push(child)
      },
      onComplete: async () => undefined,
      onStop: async (_reason, result) => {
        stoppedIncomplete = result?.complete === false
      },
    })
    await harness.emitBridge('tool_call', { toolName: 'task', toolCallId: 'task-call', input: prepared.tasks }, root)
    harness.emitRaw({
      id: 'slot-a',
      event: {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'partial assistant result' },
      },
    })
    harness.emitRaw({
      id: 'slot-a',
      event: {
        type: 'message_update',
        assistantMessageEvent: {
          type: 'toolcall_end',
          contentIndex: 0,
          toolCall: {
            id: 'yield-pending-stop',
            name: 'yield',
            arguments: { data: { findings: [{ description: 'preserved on stop' }] } },
          },
        },
      },
    })
    await harness.emitBridge('session_stop', { signal: new AbortController().signal }, root)

    const placeholder = attempts.find((child) => child.expectedId === 'slot-a')
    const captured = attempts.find((child) => child.expectedId === null)
    expect(attempts).toHaveLength(2)
    expect(placeholder?.submissions).toEqual([])
    expect(captured).toMatchObject({
      partialText: 'partial assistant result',
      submissions: [
        { data: { findings: [{ description: 'preserved on stop' }] }, partialText: 'partial assistant result' },
      ],
    })
    expect(stoppedIncomplete).toBe(true)
  })

  it('publishes each unknown and duplicate terminal child without discarding its captured yield', async () => {
    const harness = bridgeHarness()
    const prepared = batch(['slot-a'])
    const children: NativeChildResult[] = []
    harness.controller.activate(prepared, {
      onChildResult: (child) => {
        children.push(child)
      },
      onComplete: async () => undefined,
      onStop: async () => undefined,
    })
    await harness.emitBridge('tool_call', { toolName: 'task', toolCallId: 'task-call', input: prepared.tasks }, root)
    harness.emitRaw({
      id: 'unexpected',
      event: {
        type: 'tool_execution_start',
        toolName: 'yield',
        toolCallId: 'unexpected-yield',
        args: { data: { findings: [{ description: 'unknown child evidence' }] } },
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
            { index: 0, id: 'slot-a', exitCode: 0, structuredOutput: { status: 'invalid' } },
            { index: 1, id: 'unexpected', exitCode: 0, structuredOutput: { status: 'invalid' } },
            { index: 1, id: 'unexpected', exitCode: 0, structuredOutput: { status: 'invalid' } },
          ],
        },
      },
      root,
    )

    expect(children).toHaveLength(3)
    expect(children.map((child) => child.id)).toEqual(['slot-a', 'unexpected', 'unexpected'])
    expect(children.slice(1)).toMatchObject([
      { submissions: [{ data: { findings: [{ description: 'unknown child evidence' }] } }] },
      { submissions: [{ data: { findings: [{ description: 'unknown child evidence' }] } }] },
    ])
  })

  it('attempts every raw publication before stopping for a publication error', async () => {
    const harness = bridgeHarness()
    const prepared = batch(['slot-a', 'slot-b'])
    const published: string[] = []
    let stopReason: string | undefined
    harness.controller.activate(prepared, {
      onChildResult: (child) => {
        published.push(child.expectedId ?? 'unknown')
        if (child.expectedId === 'slot-a') throw new Error('publisher-a-failed')
      },
      onComplete: async () => undefined,
      onStop: async (reason) => {
        stopReason = reason
      },
    })
    await harness.emitBridge('tool_call', { toolName: 'task', toolCallId: 'task-call', input: prepared.tasks }, root)
    await harness.emitBridge(
      'tool_result',
      {
        toolName: 'task',
        toolCallId: 'task-call',
        isError: false,
        content: [],
        details: {
          results: [
            { index: 0, id: 'slot-a', exitCode: 0, structuredOutput: { status: 'invalid' } },
            { index: 1, id: 'slot-b', exitCode: 0, structuredOutput: { status: 'invalid' } },
          ],
        },
      },
      root,
    )

    expect(published).toEqual(['slot-a', 'slot-b'])
    expect(stopReason).toBe('raw-publication-failed:publisher-a-failed')
  })

  it('does not infer a zero exit from an async Bash start result', async () => {
    const harness = bridgeHarness()
    const prepared = batch(['slot-a'])
    prepared.tasks.tasks[0].proofEvidence = { purpose: 'fix-revalidate', occurrence: 'restored', causeId: 'cause-1' }
    const children: NativeChildResult[] = []
    harness.controller.activate(prepared, {
      onChildResult: (child) => {
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
      onChildResult: (child) => {
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
    harness.emitRaw({
      id: 'slot-a',
      event: {
        type: 'tool_execution_start',
        toolName: 'bash',
        toolCallId: 'setup-call',
        args: { command: 'pnpm install', cwd: '/workspace' },
      },
    })
    harness.emitRaw({
      id: 'slot-a',
      event: {
        type: 'tool_execution_end',
        toolName: 'bash',
        toolCallId: 'setup-call',
        isError: false,
        result: { details: { exitCode: 0 } },
      },
    })
    harness.emitRaw({
      id: 'slot-a',
      event: {
        type: 'tool_execution_start',
        toolName: 'bash',
        toolCallId: 'proof-call',
        args: { command: 'pnpm test -- actual' },
      },
    })
    harness.emitRaw({
      id: 'slot-a',
      event: {
        type: 'tool_execution_end',
        toolName: 'bash',
        toolCallId: 'proof-call',
        isError: false,
        result: { content: [{ type: 'text', text: 'proof output' }], details: { wallTimeMs: undefined } },
      },
    })
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
      onChildResult: (child) => {
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
    prepared.tasks.tasks[0].proofEvidence = { purpose: 'fix-falsify', occurrence: 'perturbed', causeId: 'cause-1' }
    const children: NativeChildResult[] = []
    harness.controller.activate(prepared, {
      onChildResult: (child) => {
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
    let releaseArchive: (() => void) | undefined
    const archiveStarted = new Promise<void>((resolve) => {
      releaseArchive = resolve
    })
    harness.controller.activate(prepared, {
      onChildResult: async () => {
        await archiveStarted
      },
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

    releaseArchive?.()
    await signalStop
    await ownerStop
    expect(ownerStopSettled).toBe(true)
  })

  it('conserves an unmatched child capture when its owning batch stops', async () => {
    const harness = bridgeHarness()
    const prepared = batch(['slot-a'])
    const children: NativeChildResult[] = []
    harness.controller.activate(prepared, {
      onChildResult: (child) => {
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

  it('preserves an actual capture matching a logical task name as incomplete on abort', async () => {
    const harness = bridgeHarness()
    const prepared = batch(['slot-a'])
    const children: NativeChildResult[] = []
    let stoppedIncomplete = false
    harness.controller.activate(prepared, {
      onChildResult: (child) => {
        children.push(child)
      },
      onComplete: async () => undefined,
      onStop: async (_reason, result) => {
        stoppedIncomplete = result?.complete === false
      },
    })
    await harness.emitBridge('tool_call', { toolName: 'task', toolCallId: 'task-call', input: prepared.tasks }, root)
    const rawArgumentText = 'x'.repeat(600)
    harness.emitRaw({
      id: 'slot-a',
      event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'partial abort text' } },
    })
    harness.emitRaw({
      id: 'slot-a',
      event: {
        type: 'message_update',
        assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: rawArgumentText },
      },
    })
    harness.emitRaw({
      id: 'slot-a',
      event: {
        type: 'message_update',
        assistantMessageEvent: {
          type: 'toolcall_end',
          contentIndex: 0,
          toolCall: { id: 'malformed-yield', name: 'yield', arguments: 'not-a-yield-wrapper' },
        },
      },
    })
    await harness.emitBridge('session_stop', { signal: new AbortController().signal }, root)

    const captured = children.find((child) => child.expectedId === null)
    expect(children).toHaveLength(2)
    expect(captured).toMatchObject({
      partialText: 'partial abort text',
      submissions: [{ data: null, partialText: 'partial abort text', raw: { argumentText: rawArgumentText } }],
    })
    expect(captured?.submissions[0]?.raw).toMatchObject({ argumentDeltas: [rawArgumentText] })
    expect(stoppedIncomplete).toBe(true)
  })
})
