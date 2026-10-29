import { writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { contentReading, evidenceDeclaration } from '../../engine/__tests__/criterion-admission-fixture.ts'
import { producerImplementationOutputSchema } from '../../engine/workflow-output-schema.ts'
import { hostCompletedStructured } from '../../roxabi/feature-implementation-receipt.ts'
import { implementNativeOutcome } from '../../roxabi/feature-native-outcome.ts'
import { consultableAgentRoot } from '../../testing/protocol-retention.unit.ts'
import { batch, bridgeHarness, cleanupFixtureActions, fixtureAction } from '../../testing/review-runtime-support.ts'
import type { NativeChildResult } from '../review-runtime/contracts.ts'

const root = consultableAgentRoot()
afterEach(() => cleanupFixtureActions())

const reading = contentReading()
const { provenance: _provenance, ...producerReading } = reading
const target = reading.target

function claim(provenance?: unknown) {
  return {
    outcome: 'implemented',
    commitSHAs: [reading.code.commit],
    commands: [],
    criteria: [
      { target, verification: 'evidence', evidence: [{ ...producerReading, ...(provenance ? { provenance } : {}) }] },
    ],
    reason: 'content read at the candidate commit',
  }
}

async function capture(options: {
  data: unknown
  yielded?: unknown
  yieldChild?: string | null
  terminalChild?: string
  register?: boolean
  corruptSnapshot?: boolean
  pendingYieldOnly?: boolean
}) {
  const harness = bridgeHarness()
  const prepared = batch(['observation-action'])
  const task = prepared.tasks.tasks[0]
  if (task === undefined) throw new Error('expected a task')
  const action = fixtureAction('observation-action', 'R-workflow-implement')
  task.action = action
  task.agent = 'R-workflow-implement'
  const children: NativeChildResult[] = []
  let complete = false
  harness.controller.activate(prepared, {
    onChildResult: (child) => {
      children.push(child)
    },
    onComplete: async (result) => {
      complete = result.complete
    },
    onStop: async () => undefined,
  })
  await harness.admitBatch(prepared, 'task-call', root)
  const child = await harness.admitChild(prepared, 'observation-action', 'observation-action-2', {
    root,
    skipRootCall: true,
  })
  if (options.pendingYieldOnly) {
    await child.message({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: { id: 'yield-actual', name: 'yield', arguments: { data: options.data } },
      },
    })
  } else if (options.yieldChild !== null) {
    const yielded = options.yielded ?? options.data
    if (options.yieldChild === undefined) {
      await child.call('yield', 'yield-actual', { data: yielded })
      await child.result('yield', 'yield-actual', { data: yielded }, { content: [], details: {}, isError: false })
    } else {
      harness.emitRaw({
        id: options.yieldChild,
        event: { type: 'tool_execution_start', toolName: 'yield', toolCallId: 'yield-actual', args: { data: yielded } },
      })
    }
  }
  if (options.register === false) {
    task.action = fixtureAction('observation-action', 'R-workflow-implement', action.inputs, false)
  }
  if (options.corruptSnapshot) writeFileSync(action.snapshot.indexPath, 'changed after preparation')
  await harness.settleBatch({
    toolCallId: 'task-call',
    errors: [],
    results: [
      {
        index: 0,
        id: options.terminalChild ?? 'observation-action-2',
        agent: 'R-workflow-implement',
        exitCode: 0,
        structuredOutput: { status: 'valid', data: options.data },
      },
    ],
  })
  const resultChild = children[0]
  if (resultChild === undefined) throw new Error('expected retained child')
  return { child: resultChild, complete }
}

describe('native non-test observation capture and normalization', () => {
  it('binds a matched read-only yield to the actual action and child without inventing a command', async () => {
    const data = claim()
    expect(producerImplementationOutputSchema.safeParse(data).success).toBe(true)
    const { child, complete } = await capture({ data })
    const provenance = {
      kind: 'native' as const,
      actionId: 'observation-action',
      childId: 'observation-action-2',
      submissionIndex: 0,
      toolCallIds: [],
    }
    expect(complete).toBe(true)
    expect(child.observationProvenance).toEqual(provenance)
    expect(child.commandRuns).toEqual([])
    expect(hostCompletedStructured(child)).toEqual({
      outcome: 'implemented',
      commitSHAs: [reading.code.commit],
      reason: 'content read at the candidate commit',
      commands: [],
      criteria: [evidenceDeclaration({ ...reading, provenance })],
    })
    expect(implementNativeOutcome(child, true, new Set())).toMatchObject({
      completion: 'completed',
      strict: 'valid',
      raw: child.raw,
      observation: {
        actionId: 'observation-action',
        childId: 'observation-action-2',
        submissionIndex: 0,
        submission: child.submissions[0],
      },
    })
    expect(implementNativeOutcome(child, true, new Set()).bashCalls).toBeUndefined()
  })

  it('rejects producer-forged native provenance rather than treating it as captured evidence', async () => {
    const forged = {
      kind: 'native',
      actionId: 'other-action',
      childId: 'other-child',
      submissionIndex: 99,
      toolCallIds: ['fake-bash'],
    }
    const { child, complete } = await capture({ data: claim(forged) })
    expect(complete).toBe(false)
    expect(child.reason).toBe('executed-child-guard-failed')
    expect(child.observationProvenance).toBeUndefined()
  })

  it.each([
    ['yield from a different child', { yieldChild: 'other-child' }],
    ['different yielded data', { yielded: claim({ kind: 'native', actionId: 'forged' }) }],
    ['absent yield capture', { yieldChild: null }],
    ['a pending yield without execution', { pendingYieldOnly: true }],
    ['unregistered host binding', { register: false }],
    ['changed action snapshot', { corruptSnapshot: true }],
  ])('does not produce an admitted observation with %s', async (_label, options) => {
    const { child } = await capture({ data: claim(), ...options })
    expect(child.observationProvenance).toBeUndefined()
    expect(implementNativeOutcome(child, child.usable, new Set()).observation).toBeUndefined()
    expect(hostCompletedStructured(child)).toEqual({
      outcome: 'implemented',
      commitSHAs: [reading.code.commit],
      reason: 'content read at the candidate commit',
      commands: [],
      criteria: [{ target, verification: 'unverified', reason: 'observation-provenance-unresolved' }],
    })
  })
})
