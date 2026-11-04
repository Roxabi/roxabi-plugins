import { recordsOf } from '../engine/workflow-control.ts'
import { reviewControllerFor } from '../omp/omp-controller.ts'
import { dispatchPreparedReplacementReview } from '../omp/omp-review-dispatch.ts'
import {
  ghGrantInterruptedReviewReplacement,
  ghReplaceInterruptedReview,
  ghTerminalizeInterruptedReview,
} from '../roxabi/review-recovery-gh.ts'
import { createInstalledUwOperations } from '../roxabi/uw-installed-operations.ts'
import { validateReviewInput } from '../skills/feature/workflow-review-input.js'
import { history } from './feature-review-race-history.ts'
import { createReviewDriver } from './native-review-driver.ts'
import { bridgeHarness } from './review-runtime-support.ts'

async function stopExpected(controller: { stop(reason: string): Promise<void> }, reason: string): Promise<void> {
  try {
    await controller.stop(reason)
  } catch (error) {
    if (!(error instanceof Error) || error.message !== `review-stopped:${reason}`) throw error
  }
}

async function prepareReplacement(cwd: string) {
  const oldHistory = await history(cwd)
  const interrupted = recordsOf(oldHistory).find(
    (record) =>
      record.kind === 'review-attempt' && record.payload.stage === 'initial' && record.payload.purpose === 'review',
  )
  if (interrupted === undefined || interrupted.kind !== 'review-attempt')
    throw new Error('interrupted-review-root-missing')
  const operations = await createInstalledUwOperations({
    cwd,
    operator: {
      async executeConfirmed() {
        throw new Error('unexpected-uw-write')
      },
    },
  })
  const terminal = await ghTerminalizeInterruptedReview({ cwd, pr: 7 })
  if (!terminal.ok) throw new Error(`terminalize-refused:${JSON.stringify(terminal.diagnostics)}`)
  const options = { cwd, pr: 7, contextWindow: 128_000, operations }
  const grant = await ghGrantInterruptedReviewReplacement(options)
  if (!grant.ok) throw new Error(`replacement-grant-refused:${JSON.stringify(grant.diagnostics)}`)
  const replacement = await ghReplaceInterruptedReview(options)
  if (!replacement.ok) throw new Error(`replacement-publish-refused:${JSON.stringify(replacement.diagnostics)}`)
  const { input, inventory, grantId } = replacement.value
  const actualRoot = { scope: input.scope, kind: 'review-attempt' as const, recordId: inventory.recordId }
  const exact = await validateReviewInput(cwd, 7, input.pr.head, input.capture.input, { reviewedRoot: actualRoot })
  if (!exact.ok) throw new Error(`replacement-exact-root-refused:${JSON.stringify(exact)}`)
  return { interrupted, exact, input, inventory, grantId }
}

export async function invokeReplacementDispatch(cwd: string) {
  const old = await createReviewDriver(cwd)
  await stopExpected(old.controller, 'interrupted-replacement-fixture')
  const { interrupted, exact, input, inventory, grantId } = await prepareReplacement(cwd)
  const harness = bridgeHarness()
  const productController = reviewControllerFor(harness.native)
  const model = { id: 'fixture-model', provider: 'fixture-provider', contextWindow: 128_000 }
  await harness.emitBridge(
    'session_start',
    {},
    {
      cwd,
      agent: { kind: 'main', id: 'Main', name: 'main', depth: 0 },
      sessionManager: { getSessionId: () => 'replacement-review-session' },
      model,
      models: { resolve: () => model, current: () => model },
      isIdle: () => true,
    },
  )
  try {
    await dispatchPreparedReplacementReview(harness.native, { cwd }, input, inventory, grantId)
    const active = productController.active()
    const actual = active === null ? null : { operationId: active.operationId }
    await stopExpected(productController, 'replacement-positive-complete')
    if (productController.active() !== null) throw new Error('replacement-positive-still-active')
    const priorMessages = harness.messages.length
    let wrongError = ''
    try {
      await dispatchPreparedReplacementReview(harness.native, { cwd }, input, interrupted, grantId)
    } catch (error) {
      wrongError = error instanceof Error ? error.message : String(error)
    }
    const wrongActive = reviewControllerFor(harness.native).active()
    return {
      exact,
      replacementId: inventory.recordId,
      interruptedId: interrupted.recordId,
      active: actual,
      expectedOperation: inventory.operationId,
      messages: harness.messages.slice(0, priorMessages),
      wrongActive: wrongActive?.operationId ?? null,
      wrongAnnounced: harness.messages
        .slice(priorMessages)
        .some((message) => message.includes('OMP_BUILD_NATIVE_BATCH:')),
      wrongError,
    }
  } finally {
    await harness.controller.stop('replacement-fixture-cleanup')
    await stopExpected(productController, 'replacement-fixture-product-cleanup')
  }
}
