import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { parseIssueSpecBody, rawSource, renderIssueSpecBody } from '../../adapters/github-native/uw-spec.ts'
import { canonicalSpec } from '../../engine/uw-spec.ts'
import { resolveAcceptedSpec } from '../../engine/workflow-accepted-spec.ts'
import type { ContinueFeatureResult, FeatureCommandHost, FeatureWorkflow } from '../../roxabi/feature-contract.ts'
import { deliverFeatureResult } from '../../roxabi/feature-entry.ts'
import type { PreparedReviewBatch, ReviewContext, ReviewPublisher } from '../../roxabi/review-contract.ts'
import { nativeReviewChild } from '../../testing/native-review-child.ts'
import { consultableAgentRoot } from '../../testing/protocol-retention.unit.ts'
import { batch, bridgeHarness, cleanupFixtureActions } from '../../testing/review-runtime-support.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { claimFixIngress, createOmpReviewProduct, reviewControllerFor } from '../omp-controller.ts'
import type { NativeExecutionObservation } from '../review-runtime/contracts.ts'
import { createNativeReviewPort } from '../review-runtime/port.ts'

afterEach(() => cleanupFixtureActions())

const fix: Extract<ContinueFeatureResult, { kind: 'fix' }> = {
  kind: 'fix',
  reference: '#7',
  reviewId: 'review-7',
  scope: 'correct the reviewed finding',
  requiredFeatureMandate: {
    scope: { repository: 'acme/widgets', target: 'acme/widgets#42' },
    recordId: 'mandate-42',
    kind: 'mandate',
  },
}

function admittedCorrection(): Extract<ContinueFeatureResult, { kind: 'admitted-ci-correction' }> {
  const scope = { repository: 'acme/widgets', target: 'acme/widgets#42' }
  const canonical = canonicalSpec({
    format: 'omp-build-spec-content/1',
    criteria: [{ id: 'C1', statement: 'Correct the confirmed CI failure.' }],
    invariants: [],
    exclusions: [],
    openQuestions: [],
    sections: { origin: '', context: '', change: '' },
  })
  if (!canonical.ok) throw new Error('expected canonical Spec')
  const body = renderIssueSpecBody(canonical.value)
  const parsed = parseIssueSpecBody({ uw: scope, raw: rawSource(scope.target, body, null) })
  if (parsed.status !== 'conformant') throw new Error('expected conformant Spec')
  const fixtures = roxabiWorkflowFixtures()
  const mandate = fixtures.featureMandate(scope, {
    recordId: 'mandate-42',
    body,
    ownSpec: fixtures.ownSpecFromSnapshot(scope, parsed.snapshot),
  })
  const resolved = resolveAcceptedSpec(mandate, [fixtures.historyFrom([mandate])])
  if (!resolved.ok) throw new Error('expected accepted Spec')
  return {
    kind: 'admitted-ci-correction',
    reference: '#42',
    attributionRecordId: 'attribution-42',
    uw: { ownSpec: resolved.spec, children: [] },
  }
}

async function scenario(next: Extract<ContinueFeatureResult, { kind: 'fix' | 'admitted-ci-correction' }>) {
  const harness = bridgeHarness()
  const controller = reviewControllerFor(harness.native)
  controller.bindHostGit(() => null)
  const context = consultableAgentRoot()
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
  const messages: string[] = []
  const workflow: FeatureWorkflow = {
    continueFeature: async (input) => {
      expect(input.owned?.()).toBe(true)
      expect(controller.hasLiveBatchExcept(() => false)).toBe(true)
      selected.resolve()
      await releaseSelection.promise
      return next
    },
    consumeWatchExit: async () => ({ kind: 'blocked', reason: 'unexpected-watch' }),
    publishFeatureNativeResult: async () => {
      throw new Error('unexpected-publication')
    },
    requestFeatureSessionPause: async () => ({ kind: 'paused', confirmed: false, reason: 'unconfirmed' }),
  }
  const start = async (kind: string, current?: () => boolean) => {
    expect(current?.()).toBe(true)
    // Exercise the real fix ingress writer gate rather than manufacturing a fence identity.
    const release = claimFixIngress(harness.native)
    delivered.push(kind)
    release()
    return { terminal: Promise.resolve({ status: 'stopped' as const, diagnostics: [] }) }
  }
  const host: FeatureCommandHost = {
    key: harness.native,
    cwd: '/fixture-root',
    principal: false,
    workflow,
    native: createNativeReviewPort(harness.native, controller),
    send: async (message) => {
      messages.push(message)
    },
    status: () => {},
    startFraming: async () => {
      throw new Error('unexpected-framing')
    },
    inhibitFeatureContinuation: () => controller.inhibitFeatureContinuation(),
    releaseFeatureContinuation: () => controller.releaseFeatureContinuation(),
    featureContinuationInhibited: () => controller.featureContinuationInhibited(),
    markFeatureBatch: (value) => controller.markFeatureBatch(value),
    startFix: async (_input, current) => start('fix', current),
    startAdmittedCiCorrection: async (_input, current) => start('admitted-ci-correction', current),
    startReview: async (_reference, onComplete) => {
      const publisher: ReviewPublisher = {
        authorize: async () => ({ ok: true }),
        publishInventory: async () => ({ ok: true }),
        publishRawContribution: async (_batch, child) => ({ id: 'contribution', child }),
        completeStage: async () => null,
        afterComplete: async (canContinue) => (await onComplete(canContinue)) || undefined,
        publishRequiredStop: async () => ({ ok: true }),
        stop: async () => {},
      }
      controller.markFeatureBatch(prepared.batch)
      await createOmpReviewProduct(harness.native, publisher).preparePullRequestReview(reviewContext, prepared)
    },
    exec: async () => ({ code: -1, killed: true }),
  }
  await deliverFeatureResult('#42', { kind: 'review', pr: 7 }, host)
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
    messages,
    terminal: controller.settlementFor(prepared.batch),
  }
}

it.each(['fix', 'admitted-ci-correction'] as const)(
  'selects %s under the review writer and delivers only after execution and retirement',
  async (kind) => {
    const f = await scenario(kind === 'fix' ? fix : admittedCorrection())
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
      expect(f.delivered).toEqual([kind])
      expect(f.controller.hasLiveBatchExcept(() => false)).toBe(false)
      expect(f.messages).toEqual([])
    } finally {
      f.releaseSelection.resolve()
      f.controller.finishExecution(f.prepared)
      await Promise.allSettled([f.terminal])
    }
  },
)

it('does not bypass a foreign writer when the selected fix is delivered', async () => {
  const f = await scenario(fix)
  await f.selected
  const foreign = batch(['foreign-slot'])
  f.controller.activate(foreign, { onComplete: async () => {}, onStop: async () => {} })
  try {
    f.releaseSelection.resolve()
    f.controller.finishExecution(f.prepared)
    await expect(f.terminal).rejects.toThrow('fix-known-native-writer-active')
    expect(f.delivered).toEqual([])
    expect(f.messages).toEqual(['feature-stopped: correction-delivery-failed: fix-known-native-writer-active'])
  } finally {
    f.releaseSelection.resolve()
    f.controller.finishExecution(f.prepared)
    await f.controller.stopOwned(foreign, 'test-cleanup')
    await Promise.allSettled([f.terminal])
  }
})

it('does not deliver a correction when review is cancelled during selection', async () => {
  const f = await scenario(fix)
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
