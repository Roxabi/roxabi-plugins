import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { PreparedReviewBatch, ReviewContext, ReviewPublisher } from '../../roxabi/review-contract.ts'
import { nativeReviewChild } from '../../testing/native-review-child.ts'
import { batch, bridgeHarness, cleanupFixtureActions } from '../../testing/review-runtime-support.ts'
import { claimFixIngress, createOmpReviewProduct, reviewControllerFor } from '../omp-controller.ts'
import type { NativeExecutionObservation } from '../review-runtime/contracts.ts'
import { featureCommandContext } from './feature-command-fixture.ts'

afterEach(() => cleanupFixtureActions())

async function scenario() {
  const harness = bridgeHarness()
  const controller = reviewControllerFor(harness.native)
  controller.bindHostGit(() => null)
  const context = featureCommandContext('/fixture-root')
  const prepared: PreparedReviewBatch = {
    stage: 'synthesis',
    rootAttemptId: 'review-root',
    inventory: {},
    batch: batch(['review-slot']),
  }
  const reviewContext: ReviewContext = {
    repository: 'acme/widgets',
    target: 'acme/widgets#7',
    candidateGitSHA: 'b'.repeat(40),
    input: null,
    runId: 'review-run',
    operationId: 'review-operation',
    subject: { kind: 'pull-request' },
  }
  // Initialize the fixture root and event bus, then leave the actual review to the production controller.
  harness.controller.activate(prepared.batch, { onComplete: async () => {}, onStop: async () => {} })
  expect(await harness.admitBatch(prepared.batch, 'review-call', context)).toBe(true)
  harness.controller.finishExecution(prepared.batch)
  harness.controller.inactive()
  const selected = Promise.withResolvers<void>()
  const releaseSelection = Promise.withResolvers<void>()
  const delivered: string[] = []
  const publisher: ReviewPublisher = {
    authorize: async () => ({ ok: true }),
    publishInventory: async () => ({ ok: true }),
    publishRawContribution: async (_batch, child) => ({ id: 'contribution', child }),
    completeStage: async () => null,
    afterComplete: async (canContinue) => {
      expect(canContinue()).toBe(true)
      expect(controller.hasLiveBatchExcept(() => false)).toBe(true)
      selected.resolve()
      await releaseSelection.promise
      if (!canContinue()) return undefined
      return async () => {
        const release = claimFixIngress(harness.native)
        delivered.push('fix')
        release()
      }
    },
    publishRequiredStop: async () => ({ ok: true }),
    stop: async () => {},
  }
  await createOmpReviewProduct(harness.native, publisher).preparePullRequestReview(reviewContext, prepared)
  expect(controller.admit(prepared.batch, 'review-call', context as never, () => true)).toBe(true)
  expect(controller.bindChild('review-slot', 0, { id: 'fixture-model', provider: 'fixture-provider' })).toBe(true)
  const task = prepared.batch.tasks.tasks[0]
  const sessionFile = join(tmpdir(), `fixture-child-${randomUUID()}.jsonl`)
  harness.native.events.emit('task:subagent:lifecycle', {
    status: 'started',
    id: 'review-slot',
    agent: task.agent,
    index: 0,
    parentToolCallId: 'review-call',
    sessionFile,
    detached: false,
  })
  const child = await nativeReviewChild({ task, sessionFile })
  const input = { data: { findings: [] } }
  await child.call('yield', 'review-yield', input)
  await child.result('yield', 'review-yield', input, { content: [], details: {}, isError: false })
  const observation: NativeExecutionObservation = {
    toolCallId: 'review-call',
    errors: [],
    results: [
      {
        index: 0,
        id: 'review-slot',
        agent: 'R-review-adversarial',
        exitCode: 0,
        structuredOutput: { status: 'valid', data: { findings: [] } },
      },
    ],
  }
  controller.prepareOwnedResult(observation, context as never)
  controller.queueOwnedSettlement(observation)
  return {
    controller,
    prepared: prepared.batch,
    selected: selected.promise,
    releaseSelection,
    delivered,
    terminal: controller.settlementFor(prepared.batch),
  }
}

it('admits a successor fix only after the review writer and execution retire', async () => {
  const f = await scenario()
  try {
    await f.selected
    expect(f.delivered).toEqual([])
    f.releaseSelection.resolve()
    const turn = Promise.withResolvers<void>()
    setImmediate(turn.resolve)
    await turn.promise
    expect(f.delivered).toEqual([])
    expect(f.controller.hasLiveBatchExcept(() => false)).toBe(true)
    f.controller.finishExecution(f.prepared)
    await f.terminal
    expect(f.delivered).toEqual(['fix'])
    expect(f.controller.hasLiveBatchExcept(() => false)).toBe(false)
  } finally {
    f.releaseSelection.resolve()
    f.controller.finishExecution(f.prepared)
    await Promise.allSettled([f.terminal])
  }
})

it('does not bypass a foreign writer when the selected fix is delivered', async () => {
  const f = await scenario()
  await f.selected
  const foreign = batch(['foreign-slot'])
  f.controller.activate(foreign, { onComplete: async () => {}, onStop: async () => {} })
  try {
    f.releaseSelection.resolve()
    f.controller.finishExecution(f.prepared)
    await expect(f.terminal).rejects.toThrow('fix-known-native-writer-active')
    expect(f.delivered).toEqual([])
  } finally {
    f.releaseSelection.resolve()
    f.controller.finishExecution(f.prepared)
    await f.controller.stopOwned(foreign, 'test-cleanup')
    await Promise.allSettled([f.terminal])
  }
})

it('does not deliver a correction when review is cancelled during selection', async () => {
  const f = await scenario()
  await f.selected
  const stopping = f.controller.stopOwned(f.prepared, 'operator-stop')
  try {
    f.releaseSelection.resolve()
    f.controller.finishExecution(f.prepared)
    await stopping
    await f.terminal
    expect(f.delivered).toEqual([])
  } finally {
    f.releaseSelection.resolve()
    f.controller.finishExecution(f.prepared)
    await Promise.allSettled([stopping, f.terminal])
  }
})
