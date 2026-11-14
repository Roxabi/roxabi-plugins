import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ActionPurpose } from '../../engine/action-input-schema.ts'
import { acceptedActionInputs } from '../../testing/action-input-fixtures.ts'
import { consultableAgentRoot } from '../../testing/protocol-retention.unit.ts'
import { batch, bridgeHarness, cleanupFixtureActions, fixtureAction } from '../../testing/review-runtime-support.ts'
import { shippedMandate } from '../../testing/workflow-decision-cases/support/workflow-decision-fixtures.ts'
import type { NativeBatch } from '../review-runtime/contracts.ts'

const root = consultableAgentRoot()

afterEach(() => {
  cleanupFixtureActions()
})

/**
 * Semantic state classes of the root `omp-build` status line, not pinned sentences: any wording in a
 * class satisfies the contract. Queued means waiting for root admission; withdrawn means no executor
 * started, never that the workflow had no effect; a finished run is not a workflow verdict.
 */
const QUEUED = /\bqueued\b/i
const RUNNING = /\brunning\b/i
const STOPPING = /\bstopping\b/i
const WITHDRAWN = /\bwithdrawn\b|\b(?:never|not) started\b/i
const NOTHING_RUNNING =
  /\bnothing (?:is |was )?(?:running|executing|in progress)\b|\bno executor (?:is )?(?:running|active)\b/i
const NO_BUSINESS_EFFECT =
  /\bno (?:business |workflow )?effects?\b|\bnothing (?:was |has been )?(?:done|changed|executed|happened|published)\b/i
const WORKFLOW_SUCCESS = /\b(?:success(?:ful(?:ly)?)?|succeeded|passed|approved|done|completed?)\b/i

type Projected = {
  batch: NativeBatch
  /** The sealed manifest subject: the UW target, or the standalone pull request. */
  subject: string
  purpose: ActionPurpose
  agents: readonly string[]
}

let sequence = 0

/** A batch sealed for one accepted UW; its technical operation id must never reach the operator. */
function uwBatch(purpose: ActionPurpose, agents: readonly string[]): NativeBatch {
  sequence += 1
  const inputs = acceptedActionInputs(shippedMandate(), purpose)
  return {
    operationId: `technical-op-${sequence}`,
    tasks: {
      context: 'business projection fixture',
      tasks: agents.map((agent, index) => {
        const name = `${purpose}-${sequence}-${index}`
        return { name, agent, task: name, solutionSpace: 'fixed fixture', action: fixtureAction(name, agent, inputs) }
      }),
    },
  }
}

/** The business facts the status line must project, read back from the sealed fixture itself. */
function projected(prepared: NativeBatch): Projected {
  const first = prepared.tasks.tasks[0]
  if (first === undefined) throw new Error('expected a sealed task')
  const manifest = first.action.inputs.manifest
  const subject = manifest.subject.kind === 'uw' ? manifest.subject.uw.target : manifest.subject.pullRequest.target
  return {
    batch: prepared,
    subject,
    purpose: manifest.purpose,
    agents: [...new Set(prepared.tasks.tasks.map((task) => task.agent))],
  }
}

/** The purpose as its own word, not as a fragment of an executor profile name. */
function purposeWord(purpose: ActionPurpose): RegExp {
  return new RegExp(`(?:^|[^a-z-])${purpose.replace('-', '[- ]')}(?:$|[^a-z-])`, 'i')
}

function expectBusinessIdentity(text: string | undefined, expected: Projected): void {
  expect(text).toBeDefined()
  expect(text).toContain(expected.subject)
  expect(text).toMatch(purposeWord(expected.purpose))
  for (const agent of expected.agents) expect(text).toContain(agent)
  expect(text).not.toContain(expected.batch.operationId)
}

function statusLine() {
  const writes: Array<string | undefined> = []
  return {
    set: (key: string, text: string | undefined) => {
      if (key === 'omp-build') writes.push(text)
    },
    writes,
    last: () => writes.at(-1),
    everRunning: () => writes.some((text) => text !== undefined && RUNNING.test(text)),
  }
}

function idle() {
  return { onComplete: async () => undefined, onStop: async () => undefined }
}

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

/** The SDK task call returning after an owner stop aborted it: no child terminal is observed. */
function abortedExecution() {
  return { toolCallId: 'task-call', errors: ['aborted by owner stop'], results: [] }
}

describe('native batch business projection on the root status line', () => {
  it('names the UW, business action and executors of a queued batch without claiming execution', async () => {
    const harness = bridgeHarness()
    const status = statusLine()
    const context = { ...root, ui: { setStatus: status.set } }
    await harness.emitBridge('session_start', { type: 'session_start' }, context)
    const review = projected(uwBatch('plan-review', ['R-workflow-plan-architect', 'R-workflow-plan-adversarial']))

    harness.controller.activate(review.batch, idle())

    expectBusinessIdentity(status.last(), review)
    expect(status.last()).toMatch(QUEUED)
    expect(status.everRunning()).toBe(false)
  })

  it('reports execution only once the owned tool call is admitted', async () => {
    const harness = bridgeHarness()
    const status = statusLine()
    const context = { ...root, ui: { setStatus: status.set } }
    await harness.emitBridge('session_start', { type: 'session_start' }, context)
    const plan = projected(uwBatch('plan', ['R-workflow-plan']))
    harness.controller.activate(plan.batch, idle())
    expect(status.everRunning()).toBe(false)

    expect(await harness.admitBatch(plan.batch, 'task-call', context)).toBe(true)

    expectBusinessIdentity(status.last(), plan)
    expect(status.last()).toMatch(RUNNING)
    expect(status.last()).not.toMatch(QUEUED)
  })

  it('withdraws a never-admitted batch as not started without denying prior business effects', async () => {
    const harness = bridgeHarness()
    const status = statusLine()
    const context = { ...root, ui: { setStatus: status.set } }
    await harness.emitBridge('session_start', { type: 'session_start' }, context)
    const plan = projected(uwBatch('plan', ['R-workflow-plan']))
    harness.controller.activate(plan.batch, idle())

    await harness.controller.stopOwned(plan.batch, 'owner-stop')

    const withdrawn = status.last()
    expectBusinessIdentity(withdrawn, plan)
    expect(withdrawn).toMatch(WITHDRAWN)
    expect(withdrawn).not.toMatch(NO_BUSINESS_EFFECT)
    expect(withdrawn).not.toMatch(WORKFLOW_SUCCESS)
    expect(status.everRunning()).toBe(false)
  })

  it('keeps an admitted stop non-idle and does not claim executor cessation', async () => {
    const harness = bridgeHarness()
    const status = statusLine()
    const context = { ...root, ui: { setStatus: status.set } }
    await harness.emitBridge('session_start', { type: 'session_start' }, context)
    const plan = projected(uwBatch('plan', ['R-workflow-plan']))
    const onStop = vi.fn(async () => undefined)
    harness.controller.activate(plan.batch, { onComplete: async () => undefined, onStop })
    expect(await harness.admitBatch(plan.batch, 'task-call', context)).toBe(true)

    const stopping = harness.controller.stopOwned(plan.batch, 'owner-stop')
    await vi.waitFor(() => expect(status.last()).toMatch(STOPPING))
    const settling = status.last()
    expectBusinessIdentity(settling, plan)
    expect(settling).not.toMatch(NOTHING_RUNNING)
    await harness.settleBatch(abortedExecution())
    await stopping

    const stopped = status.last()
    expectBusinessIdentity(stopped, plan)
    expect(onStop).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ complete: false }), {
      kind: 'unattributed',
      origin: 'host-stop',
    })
    expect(stopped).not.toMatch(WITHDRAWN)
    expect(stopped).not.toMatch(NOTHING_RUNNING)
    expect(stopped).not.toMatch(WORKFLOW_SUCCESS)
  })

  it('does not present a finished native run as a workflow success', async () => {
    const harness = bridgeHarness()
    const status = statusLine()
    const context = { ...root, ui: { setStatus: status.set } }
    await harness.emitBridge('session_start', { type: 'session_start' }, context)
    const prepared = batch(['slot-a'])
    const review = projected(prepared)
    const onComplete = vi.fn(async () => undefined)
    const onStop = vi.fn(async () => undefined)
    harness.controller.activate(prepared, { onComplete, onSettled: async () => undefined, onStop })
    expect(await harness.admitBatch(prepared, 'task-call', context)).toBe(true)
    await harness.admitChild(prepared, 'slot-a', 'slot-a', { root: context, skipRootCall: true })
    await harness.yieldChild('slot-a', { findings: [] })

    await harness.settleBatch(completingResult('slot-a'))

    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(onStop).not.toHaveBeenCalled()
    const finished = status.last()
    expectBusinessIdentity(finished, review)
    expect(finished).not.toMatch(RUNNING)
    expect(finished).not.toMatch(WORKFLOW_SUCCESS)
  })

  it('keeps the newer batch identity when an older batch settles late', async () => {
    const harness = bridgeHarness()
    const status = statusLine()
    const context = { ...root, ui: { setStatus: status.set } }
    await harness.emitBridge('session_start', { type: 'session_start' }, context)
    const older = projected(uwBatch('plan', ['R-workflow-plan']))
    const newer = projected(batch(['slot-b']))
    const gate = Promise.withResolvers<void>()
    let entered = false
    harness.controller.activate(older.batch, {
      onComplete: async () => undefined,
      onStop: async () => {
        entered = true
        await gate.promise
      },
    })
    const stopping = harness.controller.stopOwned(older.batch, 'owner-stop')
    await vi.waitFor(() => expect(entered).toBe(true))
    harness.controller.activate(newer.batch, idle())

    gate.resolve()
    await stopping

    const current = status.last()
    expectBusinessIdentity(current, newer)
    expect(current).toMatch(QUEUED)
    expect(current).not.toContain('R-workflow-plan')
  })

  it('writes no phase of an old-session batch into a new root session', async () => {
    const harness = bridgeHarness()
    const status = statusLine()
    const first = { ...root, sessionManager: { getSessionId: () => 'first' }, ui: { setStatus: status.set } }
    await harness.emitBridge('session_start', { type: 'session_start' }, first)
    const plan = projected(uwBatch('plan', ['R-workflow-plan']))
    harness.controller.activate(plan.batch, idle())
    expect(await harness.admitBatch(plan.batch, 'task-call', first)).toBe(true)
    const second = { ...first, sessionManager: { getSessionId: () => 'second' } }
    await harness.emitBridge('session_start', { type: 'session_start' }, second)
    const switched = status.writes.length

    const stopping = harness.controller.stopOwned(plan.batch, 'owner-stop')
    await harness.settleBatch(abortedExecution())
    await stopping

    expect(status.writes.slice(switched)).toEqual([])
  })
})
