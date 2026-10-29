import { afterEach, describe, expect, it } from 'vitest'
import { consultableAgentRoot } from '../../testing/protocol-retention.unit.ts'
import { batch, bridgeHarness, cleanupFixtureActions } from '../../testing/review-runtime-support.ts'
import type { NativeChildResult } from '../review-runtime/contracts.ts'

const root = consultableAgentRoot()

afterEach(() => {
  cleanupFixtureActions()
})

describe('native review bridge capture', () => {
  it('binds same-profile native children by their SDK task identity rather than agent role', async () => {
    const harness = bridgeHarness()
    const prepared = batch(['chunk-1', 'chunk-2'])
    harness.controller.activate(prepared, { onComplete: async () => undefined, onStop: async () => undefined })
    await harness.emitBridge(
      'tool_call',
      { toolName: 'task', toolCallId: 'task-call', input: harness.controller.wire(prepared) },
      root,
    )

    for (const spawnKey of ['chunk-1', 'chunk-2']) {
      await harness.admitChild(prepared, spawnKey, spawnKey, { root, skipRootCall: true })
    }
    expect(
      await harness.emitBridge(
        'before_subagent_spawn',
        { agent: 'R-review-adversarial', invocationKind: 'task', patterns: [], spawnKey: 'chunk-2' },
        root,
      ),
    ).toMatchObject({ block: true })
    expect(
      await harness.emitBridge(
        'before_subagent_spawn',
        { agent: 'R-review-adversarial', invocationKind: 'task', patterns: [], spawnKey: 'unprepared' },
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
    await harness.admitChild(prepared, 'slot-a', 'slot-a-2', { root, skipRootCall: true })
    await harness.yieldChild('slot-a-2', { findings: [] })
    await harness.emitBridgeAndSettle(
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
              agent: 'R-review-adversarial',
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
      onChildResult: (child): void => {
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
    for (const name of ['slot-a', 'slot-b']) {
      const id = `${name}-2`
      await harness.admitChild(prepared, name, id, { root, skipRootCall: true })
      await harness.yieldChild(id, { findings: [] })
    }
    await harness.emitBridgeAndSettle(
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
              id: 'slot-b-2',
              agent: 'R-review-adversarial',
              exitCode: 0,
              structuredOutput: { status: 'valid', data: { findings: [] } },
            },
            {
              index: 0,
              id: 'slot-a-2',
              agent: 'R-review-adversarial',
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
      { expectedId: 'slot-a', id: 'slot-a-2' },
      { expectedId: 'slot-b', id: 'slot-b-2' },
    ])
  })

  it('retains unvalidated data from a schema-rejected yield', async () => {
    const harness = bridgeHarness()
    const prepared = batch(['slot-a'])
    const attempts: NativeChildResult[] = []
    let stopReason: string | undefined
    harness.controller.activate(prepared, {
      onChildResult: (child): void => {
        attempts.push(child)
      },
      onComplete: async () => undefined,
      onStop: async (reason) => {
        stopReason = reason
      },
    })
    await harness.emitBridge(
      'tool_call',
      { toolName: 'task', toolCallId: 'task-call', input: harness.controller.wire(prepared) },
      root,
    )
    const child = await harness.admitChild(prepared, 'slot-a', 'slot-a', { root, skipRootCall: true })
    const input = { data: { findings: [{ description: 'extractable despite schema rejection' }] } }
    await child.call('yield', 'yield-1', input)
    await child.result('yield', 'yield-1', input, { content: [], details: {}, isError: true })
    await harness.emitBridgeAndSettle(
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
              agent: 'R-review-adversarial',
              exitCode: 0,
              structuredOutput: { status: 'invalid' },
            },
          ],
        },
      },
      root,
    )
    expect(stopReason).toBe('executed-child-guard-failed')
    expect(attempts).toMatchObject([
      { submissions: [{ data: { findings: [{ description: 'extractable despite schema rejection' }] } }] },
    ])
  })

  it('does not reuse content-index deltas and flushes an unexecuted yield on terminal failure', async () => {
    const harness = bridgeHarness()
    const prepared = batch(['slot-a'])
    const attempts: NativeChildResult[] = []
    harness.controller.activate(prepared, {
      onChildResult: (child): void => {
        attempts.push(child)
      },
      onComplete: async () => undefined,
      onStop: async () => undefined,
    })
    await harness.emitBridge(
      'tool_call',
      { toolName: 'task', toolCallId: 'task-call', input: harness.controller.wire(prepared) },
      root,
    )
    const child = await harness.admitChild(prepared, 'slot-a', 'slot-a', { root, skipRootCall: true })
    await child.message({ type: 'message_start', message: { role: 'assistant' } })
    await child.message({
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: 'stale-' },
    })
    await child.message({ type: 'message_end', message: { role: 'assistant', content: [] } })
    await child.message({ type: 'message_start', message: { role: 'assistant' } })
    await child.message({
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: 'fresh-' },
    })
    await child.message({
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
    })
    await harness.emitBridgeAndSettle(
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
          { data: { findings: [{ description: 'retained pending yield' }] }, raw: { argumentText: 'fresh-' } },
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
      onChildResult: (child): void => {
        attempts.push(child)
      },
      onComplete: async () => undefined,
      onStop: async (_reason, result) => {
        stoppedIncomplete = result?.complete === false
      },
    })
    await harness.emitBridge(
      'tool_call',
      { toolName: 'task', toolCallId: 'task-call', input: harness.controller.wire(prepared) },
      root,
    )
    const child = await harness.admitChild(prepared, 'slot-a', 'slot-a', { root, skipRootCall: true })
    await child.message({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'partial assistant result' },
    })
    await child.message({
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

  it('publishes unknown and duplicate terminal children without trusting unauthenticated raw evidence', async () => {
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
    await harness.emitBridge(
      'tool_call',
      { toolName: 'task', toolCallId: 'task-call', input: harness.controller.wire(prepared) },
      root,
    )
    await harness.admitChild(prepared, 'slot-a', 'slot-a', { root, skipRootCall: true })
    await harness.yieldChild('slot-a', { findings: [] })
    harness.emitRaw({
      id: 'unexpected',
      event: {
        type: 'tool_execution_start',
        toolName: 'yield',
        toolCallId: 'unexpected-yield',
        args: { data: { findings: [{ description: 'unknown child evidence' }] } },
      },
    })
    await harness.emitBridgeAndSettle(
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
              agent: 'R-review-adversarial',
              exitCode: 0,
              structuredOutput: { status: 'valid', data: { findings: [] } },
            },
            {
              index: 1,
              id: 'slot-a',
              agent: 'R-review-adversarial',
              exitCode: 0,
              structuredOutput: { status: 'valid', data: { findings: [] } },
            },
            { index: 1, id: 'unexpected', exitCode: 0, structuredOutput: { status: 'invalid' } },
          ],
        },
      },
      root,
    )
    expect(children).toHaveLength(3)
    expect(children.map((child) => child.id)).toEqual(['slot-a', 'slot-a', 'unexpected'])
    expect(children[0]?.submissions).toMatchObject([{ data: { findings: [] } }])
    expect(children[1]?.submissions).toMatchObject([{ data: { findings: [] } }])
    expect(children[2]?.submissions).toEqual([])
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
    await harness.emitBridge(
      'tool_call',
      { toolName: 'task', toolCallId: 'task-call', input: harness.controller.wire(prepared) },
      root,
    )
    await harness.emitBridgeAndSettle(
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

  it('preserves an actual capture matching a logical task name as incomplete on abort', async () => {
    const harness = bridgeHarness()
    const prepared = batch(['slot-a'])
    const children: NativeChildResult[] = []
    let stoppedIncomplete = false
    harness.controller.activate(prepared, {
      onChildResult: (child): void => {
        children.push(child)
      },
      onComplete: async () => undefined,
      onStop: async (_reason, result) => {
        stoppedIncomplete = result?.complete === false
      },
    })
    await harness.emitBridge(
      'tool_call',
      { toolName: 'task', toolCallId: 'task-call', input: harness.controller.wire(prepared) },
      root,
    )
    const child = await harness.admitChild(prepared, 'slot-a', 'slot-a', { root, skipRootCall: true })
    const rawArgumentText = 'x'.repeat(600)
    await child.message({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'partial abort text' },
    })
    await child.message({
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: rawArgumentText },
    })
    await child.message({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: { id: 'malformed-yield', name: 'yield', arguments: 'not-a-yield-wrapper' },
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
