import { writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { contentReading } from '../../engine/__tests__/criterion-admission-fixture.ts'
import { actionInputDigest } from '../../engine/action-input.ts'
import { producerImplementationOutputSchema } from '../../engine/workflow-output-schema.ts'
import { acceptedActionInputs } from '../../testing/action-input-fixtures.ts'
import type { NativeReviewChild } from '../../testing/native-review-child.ts'
import { consultableAgentRoot } from '../../testing/protocol-retention.unit.ts'
import { batch, bridgeHarness, cleanupFixtureActions, fixtureAction } from '../../testing/review-runtime-support.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import type { NativeChildResult } from '../review-runtime/contracts.ts'

const root = consultableAgentRoot()
afterEach(() => cleanupFixtureActions())

const originalReading = contentReading()
const mandate = roxabiWorkflowFixtures().featureMandate(originalReading.target.spec.uw, {
  body: '## Acceptance\n- [ ] reload keeps the selected region',
})
const acceptedInputs = acceptedActionInputs(mandate, 'implement')
if (acceptedInputs.manifest.spec.kind !== 'accepted') throw new Error('expected accepted implementation spec')
const reading = {
  ...originalReading,
  target: { ...originalReading.target, spec: acceptedInputs.manifest.spec.effective.own },
}
const manifest = {
  ...acceptedInputs.manifest,
  code: {
    ...acceptedInputs.manifest.code,
    head: reading.code.commit,
    referenceCommit: reading.code.commit,
  },
}
const implementationInputs = { ...acceptedInputs, manifest, fingerprint: actionInputDigest(manifest) }
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

async function captureLateCalls(child: NativeReviewChild, calls: Array<{ id: string; arguments: unknown }>) {
  for (const [contentIndex, call] of calls.entries()) {
    await child.message({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_end',
        contentIndex,
        toolCall: { id: call.id, name: 'yield', arguments: call.arguments },
      },
    })
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
  lateCalls?: Array<{ id: string; arguments: unknown }>
  secondExecution?: boolean
}) {
  const harness = bridgeHarness()
  const prepared = batch(['observation-action'])
  const task = prepared.tasks.tasks[0]
  if (task === undefined) throw new Error('expected a task')
  const action = fixtureAction('observation-action', 'R-workflow-implement', implementationInputs)
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
      if (options.secondExecution) {
        await child.call('yield', 'yield-second', { data: yielded })
        await child.result('yield', 'yield-second', { data: yielded }, { content: [], details: {}, isError: false })
      }
    } else {
      harness.emitRaw({
        id: options.yieldChild,
        event: { type: 'tool_execution_start', toolName: 'yield', toolCallId: 'yield-actual', args: { data: yielded } },
      })
    }
  }
  await captureLateCalls(child, options.lateCalls ?? [])
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
  })

  it('reconciles a delayed matching toolcall with the guarded actual yield', async () => {
    const data = claim()
    const { child, complete } = await capture({
      data,
      lateCalls: [{ id: 'yield-actual', arguments: { data } }],
    })
    expect(complete).toBe(true)
    expect(child.submissions).toHaveLength(1)
    expect(child.submissions[0]).toMatchObject({
      attemptIndex: 0,
      data,
      raw: { toolCallId: 'yield-actual', executionArguments: { data }, toolCallArguments: { data } },
    })
    expect(child.observationProvenance).toMatchObject({ submissionIndex: 0 })
  })

  it.each([
    ['different arguments on the same ID', 'yield-actual', { data: { unexpected: true } }, { unexpected: true }],
    ['malformed arguments on the same ID', 'yield-actual', 'not-an-object', null],
    ['matching arguments on a new ID', 'yield-pending', { data: claim() }, claim()],
  ])('retains %s without granting observation provenance', async (_label, id, args, pendingData) => {
    const data = claim()
    const { child } = await capture({ data, lateCalls: [{ id, arguments: args }] })
    expect(child.submissions).toHaveLength(2)
    expect(child.submissions[0]).toMatchObject({
      attemptIndex: 0,
      data,
      raw: { toolCallId: 'yield-actual', executionArguments: { data } },
    })
    expect(child.submissions[1]).toMatchObject({
      attemptIndex: 1,
      data: pendingData,
      raw: { toolCallId: id, toolCallArguments: args, executionArguments: null },
    })
    expect(child.observationProvenance).toBeUndefined()
  })

  it('keeps multiple guarded executions as separate actual-backed attempts with delayed toolcalls', async () => {
    const data = claim()
    const { child } = await capture({
      data,
      secondExecution: true,
      lateCalls: [
        { id: 'yield-actual', arguments: { data } },
        { id: 'yield-second', arguments: { data } },
      ],
    })
    expect(child.submissions).toHaveLength(2)
    expect(child.submissions).toMatchObject([
      {
        attemptIndex: 0,
        data,
        raw: { toolCallId: 'yield-actual', executionArguments: { data }, toolCallArguments: { data } },
      },
      {
        attemptIndex: 1,
        data,
        raw: { toolCallId: 'yield-second', executionArguments: { data }, toolCallArguments: { data } },
      },
    ])
    expect(child.observationProvenance).toMatchObject({ submissionIndex: 1 })
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
  })
})
