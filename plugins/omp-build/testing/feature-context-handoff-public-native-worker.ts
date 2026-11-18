import assert from 'node:assert/strict'
import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { accounted } from '../engine/review-context-authentication.ts'
import { planOutputSchema } from '../engine/workflow-output-schema.ts'
import { assessBoundPlanReview } from '../engine/workflow-plan-macro.ts'
import {
  changeOutsideEffectSpecBody,
  confirmedOutsideEffectOperator,
  outsideEffectAgentDir,
  porcelain,
  prepareOutsideEffectIntent,
} from './context-external-effect-fixture.ts'
import { createPublicNativeScenario, type NativeTerminal } from './feature-context-handoff-public-native-scenario.ts'
import { acceptContextMaterial } from './feature-context-material-driver.ts'
import { createRecoveryTestRoot } from './fix-recovery-real-root.ts'

const [cwd, rootDir, stateFile, outsidePath] = process.argv.slice(2)
if (!cwd || !rootDir || !stateFile || !outsidePath) throw new Error('public-native-worker-arguments-missing')
if (!outsidePath.startsWith('/') || outsidePath.includes(cwd))
  throw new Error('outside-effect-path-must-leave-checkout')

const notifications: string[] = []
const scenario = createPublicNativeScenario(outsidePath)
const root = await createRecoveryTestRoot({
  cwd,
  agentDir: outsideEffectAgentDir(rootDir),
  sandboxHome: rootDir,
  ghConfigDir: join(rootDir, 'gh-config'),
  ghSimulatorState: stateFile,
  credential: process.env.RECOVERY_TEST_CREDENTIAL ?? '',
  responses: [],
  agentModelOverrides: {
    'R-workflow-implement': 'recovery-test/recovery-test',
    'R-workflow-plan': 'recovery-test/recovery-test',
    'R-workflow-plan-architect': 'recovery-test/recovery-test',
    'R-workflow-plan-adversarial': 'recovery-test/recovery-test',
  },
  onApproval: async () => 'once',
  // Explicitly synthetic fixture confirmation — never live approval.
  onConfirmation: async () => 'confirm',
  onNotification: (message) => notifications.push(message),
  handler: scenario.handler,
})

const unsubscribe = root.session.subscribe((event) => {
  if (event.type === 'tool_execution_start' && event.toolName === 'omp_build_execute_native_batch') {
    scenario.observeStart(event.toolCallId)
  }
  if (
    event.type === 'tool_execution_end' &&
    event.toolName === 'omp_build_execute_native_batch' &&
    scenario.dispatches.includes(event.toolCallId)
  ) {
    scenario.observeEnd(event.toolCallId, event.isError === true, event.result)
  }
})

let stage = 'pin'
const terminate = () => {
  process.stderr.write(`public-native worker terminated at ${stage}\n`)
  void root.dispose().finally(() => process.exit(143))
}
process.once('SIGTERM', terminate)

async function bounded<T>(operation: Promise<T>, ms = 25_000): Promise<T> {
  const timeout = Promise.withResolvers<never>()
  const timer = setTimeout(
    () =>
      timeout.reject(
        new Error(
          `public-native timeout at ${stage}; notifications=${JSON.stringify(notifications)}; errors=${JSON.stringify(root.errors)}; dispatches=${JSON.stringify(scenario.dispatches)}; children=${JSON.stringify(root.children)}`,
        ),
      ),
    ms,
  )
  try {
    return await Promise.race([operation, timeout.promise])
  } finally {
    clearTimeout(timer)
  }
}

type SimState = import('./sandbox/sandbox-types.ts').SimState

async function authenticatedHistory() {
  const { decodeHistory } = await import('../adapters/github/history-codec.ts')
  const state = JSON.parse(await Bun.file(stateFile).text()) as SimState
  const comments = (state.issues['42']?.comments ?? []).map((comment, index) => ({
    locator: `acme/app#42:${index + 1}`,
    nativeId: String(index + 1),
    body: comment.body,
    author: comment.author,
    createdAt: comment.createdAt ?? null,
    updatedAt: comment.updatedAt ?? null,
  }))
  return decodeHistory({
    scope: { repository: 'acme/app', target: 'acme/app#42' },
    expectedAuthor: 'operator',
    stopAuthor: null,
    complete: true,
    diagnostics: [],
    comments,
  })
}

function actionReceipts(
  history: Awaited<ReturnType<typeof authenticatedHistory>>,
  action: 'implement' | 'plan' | 'plan-review',
) {
  return history.operations
    .filter((operation) => operation.status === 'complete')
    .map((operation) => operation.record)
    .filter(
      (record): record is Extract<NonNullable<typeof record>, { kind: 'action-receipt' }> =>
        record?.kind === 'action-receipt' && record.payload.action === action && accounted(history, record),
    )
}

function assertFreshStartResultChain(
  before: ReturnType<typeof actionReceipts>,
  after: ReturnType<typeof actionReceipts>,
  action: 'plan' | 'plan-review',
) {
  const beforeIds = new Set(before.map((record) => record.recordId))
  const fresh = after.filter((record) => !beforeIds.has(record.recordId))
  const starts = fresh.filter((record) => record.payload.phase === 'start')
  const results = fresh.filter((record) => record.payload.phase === 'result')
  assert.equal(starts.length, 1, `public-native-${action}-unique-start`)
  assert.equal(results.length, 1, `public-native-${action}-unique-result`)
  const start = starts[0]
  const result = results[0]
  assert(start?.payload.phase === 'start')
  assert(result?.payload.phase === 'result')
  assert.equal(result.payload.start.recordId, start.recordId)
  assert.deepEqual(result.payload.start.scope, { repository: start.repository, target: start.target })
  assert.equal(result.payload.actionId, start.payload.actionId)
  assert.deepEqual(result.payload.mandate, start.payload.mandate)
  assert.deepEqual(result.payload.inputs, start.payload.inputs)
  assert.equal(result.payload.native.completion, 'completed')
  assert.equal(result.payload.native.strict, 'valid')
  return { start, result }
}

/** Await correlated plan/plan-review native terminals after public new — not idle/dispatch-count. */
async function awaitCorrelatedPlanReviewTerminals(beforeDispatches: number): Promise<string[]> {
  const success = (terminal: NativeTerminal): string => {
    assert.equal(terminal.isError, false, JSON.stringify(terminal.result))
    assert(scenario.dispatches.slice(beforeDispatches).includes(terminal.toolCallId))
    return terminal.toolCallId
  }
  const [plan, review] = await bounded(scenario.waitPlanReview())
  return [success(plan), success(review)]
}

try {
  await bounded(root.session.prompt('/tooling-pin activate'))
  stage = 'feature-command'
  await bounded(root.session.prompt('/feature #42'))
  stage = 'session-idle'
  await bounded(root.session.waitForIdle())
  const called = scenario.dispatches.length > 0
  if (!called) throw new Error(`public-native-implement-not-dispatched:${JSON.stringify(notifications)}`)
  stage = 'native-completion'
  const implementId = scenario.dispatches[0]
  if (implementId === undefined) throw new Error('public-native-implement-dispatch-missing')
  const nativeResult = await bounded(scenario.waitNativeEnd(implementId))
  if (nativeResult.isError) throw new Error(`public-native-implement-failed:${JSON.stringify(nativeResult.result)}`)

  const produceExists = existsSync(outsidePath)
  const produceReal = realpathSync(outsidePath)
  const producePorcelain = porcelain(cwd)

  // Same extension/session — no dispose/process reset between abandon and public new.
  stage = 'locate-negative'
  const historyBefore = await authenticatedHistory()
  const negative = actionReceipts(historyBefore, 'implement').find((record) => record.payload.phase === 'result')
  if (negative === undefined) throw new Error('public-native-negative-missing')
  const retainedNegative = JSON.stringify(negative)

  stage = 'material-and-effects'
  const { rmSync } = await import('node:fs')
  rmSync(outsidePath, { force: true })
  const changedVersion = changeOutsideEffectSpecBody(stateFile)
  const material = await acceptContextMaterial(cwd, confirmedOutsideEffectOperator)
  const prepared = await prepareOutsideEffectIntent({
    cwd,
    negativeRecordId: negative.recordId,
    absoluteOutsidePath: outsidePath,
  })

  stage = 'public-abandon'
  const beforeAbandon = notifications.length
  await bounded(root.session.prompt('/feature abandon #42'))
  await bounded(root.session.waitForIdle())
  const abandonNotifications = notifications.slice(beforeAbandon)

  stage = 'public-new-handoff'
  const beforeNew = notifications.length
  const beforeDispatches = scenario.dispatches.length
  const historyBeforeNew = await authenticatedHistory()
  const plansBefore = actionReceipts(historyBeforeNew, 'plan')
  const reviewsBefore = actionReceipts(historyBeforeNew, 'plan-review')
  await bounded(
    root.session.prompt(
      `/feature new #42 --context-handoff ${negative.recordId} --context-effects ${prepared.effectsFile}`,
    ),
  )
  // Public new must activate and settle fresh plan then native plan-review through installed host callbacks.
  stage = 'native-plan-settlement'
  const handoffDispatches = await awaitCorrelatedPlanReviewTerminals(beforeDispatches)
  const newNotifications = notifications.slice(beforeNew)
  const continuationInhibited = newNotifications.some((message) => message.includes('continuation-inhibited'))
  if (continuationInhibited) throw new Error(`public-native-continuation-inhibited:${JSON.stringify(newNotifications)}`)
  if (handoffDispatches.length !== 2)
    throw new Error(
      `public-native-plan-review-not-dispatched:${JSON.stringify({ handoffDispatches, newNotifications })}`,
    )
  const [planDispatch, reviewDispatch] = handoffDispatches
  assert(planDispatch !== undefined && reviewDispatch !== undefined)
  if (
    scenario.phaseByDispatch.get(planDispatch) !== 'plan' ||
    scenario.phaseByDispatch.get(reviewDispatch) !== 'plan-review'
  )
    throw new Error(
      `public-native-handoff-phase-mismatch:${JSON.stringify({
        handoffDispatches,
        phaseByDispatch: Object.fromEntries(scenario.phaseByDispatch),
        newNotifications,
      })}`,
    )

  stage = 'authenticated-history'
  const historyAfter = await authenticatedHistory()
  const planChain = assertFreshStartResultChain(plansBefore, actionReceipts(historyAfter, 'plan'), 'plan')
  const planReviewChain = assertFreshStartResultChain(
    reviewsBefore,
    actionReceipts(historyAfter, 'plan-review'),
    'plan-review',
  )
  const plan = planChain.result.payload
  const review = planReviewChain.result.payload
  assert(plan.action === 'plan' && plan.phase === 'result')
  assert(review.action === 'plan-review' && review.phase === 'result')
  planOutputSchema.parse(plan.structured)
  assert.equal(review.exactInputs.draftActionId, plan.actionId)
  assert.deepEqual(review.mandate, plan.mandate)
  assert(review.inputs.manifest.spec.kind === 'accepted')
  const acceptedReview = assessBoundPlanReview(
    { ...planReviewChain.result, payload: review },
    review.inputs.manifest.spec.effective,
  )
  assert.deepEqual(acceptedReview, { ok: true, value: { clear: true, blockers: [] } })
  const retainedAfter = historyAfter.operations.find(
    (operation) => operation.record?.recordId === negative.recordId,
  )?.record
  if (retainedAfter === undefined) throw new Error('public-native-negative-dropped')
  if (JSON.stringify(retainedAfter) !== retainedNegative) throw new Error('public-native-negative-mutated')

  process.stdout.write(
    `${JSON.stringify({
      mode: 'public-same-session-handoff',
      called,
      dispatches: scenario.dispatches,
      handoffDispatches,
      children: [...root.children],
      errors: [...root.errors],
      outsidePath,
      outsideExistsAfterProduce: produceExists,
      outsideRealPathAfterProduce: produceReal,
      checkoutPorcelainAfterProduce: producePorcelain,
      negativeRecordId: negative.recordId,
      retainedNegative,
      retainedAfter: JSON.stringify(retainedAfter),
      changedVersion,
      material,
      abandonNotifications,
      newNotifications,
      continuationInhibited,
      planStartRecordId: planChain.start.recordId,
      planResultRecordId: planChain.result.recordId,
      planReviewStartRecordId: planReviewChain.start.recordId,
      planReviewResultRecordId: planReviewChain.result.recordId,
      syntheticConfirmation: true,
    })}\n`,
  )
} finally {
  process.off('SIGTERM', terminate)
  unsubscribe()
  try {
    await root.dispose()
  } catch {
    /* best-effort */
  }
}
