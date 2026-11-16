import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { viewer } from '../dist/contracts.js'
import { createPreparationCohort } from '../host/preparation-cohort.ts'
import type { FeatureReviewFix } from '../roxabi/feature-contract.ts'
import { startAdmittedCiCorrection } from '../roxabi/fix-entry-ci.ts'
import { type FixRun, type FixStart, startDefaultFix } from '../roxabi/fix-entry-lifecycle.ts'
import { FixExecutionFence } from '../roxabi/fix-execution-fence.ts'
import type { CiCorrectionAdmission } from '../roxabi/fix-mandate-types.ts'
import type { TrustedHostPluginPin } from '../roxabi/uw-action-contract.ts'
import { createInstalledUwReadPort } from '../roxabi/uw-read-port.ts'
import { nextReviewStep } from '../skills/feature/workflow-review-state.js'
import { hostPluginPin } from './host-plugin-pin.ts'
import { createHostUwOperations } from './host-uw-operations.ts'
import {
  claimFixIngress,
  createOmpFixPort,
  type FixHost,
  ownedFixRunFor,
  ownFixRun,
  releaseOwnedFixRun,
  reportFeatureTerminalStatus,
} from './omp-controller'
import { createOperatorConfirmation } from './omp-operator-confirmation.ts'
import { captureNativeRootLifetime } from './review-runtime/native-sdk-adapter.ts'

type FixDispatchKind = 'fix' | 'ci correction'

function terminalNotifier(pi: FixHost, run: FixRun, kind: FixDispatchKind) {
  return async (text: string): Promise<void> => {
    if (ownedFixRunFor(pi)?.run === run && ownedFixRunFor(pi)?.tearingDown) {
      console.error(`omp-build: ${kind} ${run.runId} ended during teardown: ${text}`)
      return
    }
    try {
      reportFeatureTerminalStatus(pi, text)
    } catch (error) {
      const label = kind === 'fix' ? 'fix terminal' : 'ci correction'
      console.error(
        `omp-build: ${label} notification failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}

async function releaseFixRun(pi: FixHost, run: FixRun, kind: FixDispatchKind): Promise<void> {
  const owned = ownedFixRunFor(pi)
  if (owned?.run !== run) return
  await run.driverTerminated
  if (owned.stopping !== undefined) {
    try {
      await owned.stopping
    } catch {
      run.executionFence.markHostUnknown('fix-stop-unconfirmed')
    }
  }
  await run.executionFence.closeHostOperations()
  const owner = kind === 'fix' ? 'fix' : 'ci'
  try {
    const settled = await run.executionFence.settleInterruptedOwner()
    if (!settled.ok)
      console.error(`omp-build: interrupted ${owner} owner remains held: ${settled.diagnostics.join(', ')}`)
  } catch (error) {
    console.error(
      `omp-build: interrupted ${owner} owner remains held: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (run.executionFence.destinationLeaseFacts() !== null) {
    const released = await run.executionFence.releaseDestinationLease()
    if (released.status !== 'released')
      console.error(
        `omp-build: ${kind} destination lease retained: ${released.diagnostics.map((item) => item.code).join(', ')}`,
      )
  }
  releaseOwnedFixRun(pi, run)
}

function ownReportingFixRun(pi: FixHost, run: FixRun, reporting: Promise<void>, kind: FixDispatchKind): void {
  const releaseOwned = () => releaseFixRun(pi, run, kind)
  const release = reporting.then(releaseOwned, releaseOwned)
  ownFixRun(pi, { run, reporting, release })
}

async function dispatchDefaultFix(
  pi: FixHost,
  ctx: ExtensionContext,
  args: string,
  options: Partial<FeatureReviewFix> = {},
  captured?: { pluginPin: TrustedHostPluginPin | undefined; continuationCurrent?: (() => boolean) | undefined },
): Promise<FixStart> {
  const releaseIngress = claimFixIngress(pi)
  const cohort = createPreparationCohort()
  const executionFence = new FixExecutionFence()
  executionFence.bindCohort(cohort)
  let driverStarted = false
  try {
    return await cohort.run(async () => {
      const root = await executionFence.trackIngress(() => captureNativeRootLifetime(ctx))
      if (root === null) throw new Error('fix-root-unavailable')
      executionFence.bindRoot(() => root.current() && (captured?.continuationCurrent?.() ?? true), root.lifetime)
      const pluginPin =
        captured === undefined ? await executionFence.trackIngress(() => hostPluginPin(pi, ctx)) : captured.pluginPin
      const automationLogin = await executionFence.trackIngress(() => viewer({ cwd: ctx.cwd }))
      const operations = await executionFence.trackIngress(() =>
        createHostUwOperations(ctx, createOperatorConfirmation(ctx), pluginPin),
      )
      if (!executionFence.rootCurrent()) throw new Error('fix-root-unavailable')
      executionFence.closeIngress()
      const run = startDefaultFix({
        cwd: ctx.cwd,
        args,
        reference: options.reference,
        reviewId: options.reviewId,
        scope: options.scope,
        requiredFeatureMandate: options.requiredFeatureMandate,
        contextWindow: typeof ctx.model?.contextWindow === 'number' ? ctx.model.contextWindow : undefined,
        native: createOmpFixPort(pi, executionFence),
        workflow: { nextReviewStep: (cwd, pr, opts) => nextReviewStep(cwd, pr, { ...opts, pluginPin }) },
        uw: createInstalledUwReadPort({ cwd: ctx.cwd, readAuthor: automationLogin }),
        operations,
        pluginPin,
      })
      driverStarted = true
      const notify = terminalNotifier(pi, run, 'fix')
      const reporting = run.completion.then(
        (result) =>
          notify(
            result.ok
              ? `/fix ${run.runId} completed with confirmed record ${result.value.recordId}.`
              : `/fix ${run.runId} stopped: ${result.diagnostics.join(', ')}`,
          ),
        (error) => notify(`/fix ${run.runId} failed: ${error instanceof Error ? error.message : String(error)}`),
      )
      ownReportingFixRun(pi, run, reporting, 'fix')
      return run.started
    })
  } finally {
    try {
      if (!driverStarted) {
        executionFence.seal()
        await executionFence.closeHostOperations()
      }
    } finally {
      releaseIngress()
    }
  }
}

async function dispatchAdmittedCiCorrection(
  pi: FixHost,
  ctx: ExtensionContext,
  input: { reference: string; attributionRecordId: string; uw: CiCorrectionAdmission['uw'] },
  captured?: { pluginPin: TrustedHostPluginPin | undefined; continuationCurrent?: (() => boolean) | undefined },
): Promise<FixRun> {
  const releaseIngress = claimFixIngress(pi)
  const cohort = createPreparationCohort()
  const executionFence = new FixExecutionFence()
  executionFence.bindCohort(cohort)
  let driverStarted = false
  try {
    return await cohort.run(async () => {
      const root = await executionFence.trackIngress(() => captureNativeRootLifetime(ctx))
      if (root === null) throw new Error('fix-root-unavailable')
      executionFence.bindRoot(() => root.current() && (captured?.continuationCurrent?.() ?? true), root.lifetime)
      const pluginPin =
        captured === undefined ? await executionFence.trackIngress(() => hostPluginPin(pi, ctx)) : captured.pluginPin
      const automationLogin = await executionFence.trackIngress(() => viewer({ cwd: ctx.cwd }))
      const operations = await executionFence.trackIngress(() =>
        createHostUwOperations(ctx, createOperatorConfirmation(ctx), pluginPin),
      )
      if (!executionFence.rootCurrent()) throw new Error('fix-root-unavailable')
      executionFence.closeIngress()
      const run = startAdmittedCiCorrection({
        cwd: ctx.cwd,
        reference: input.reference,
        attributionRecordId: input.attributionRecordId,
        expectedUw: input.uw,
        native: createOmpFixPort(pi, executionFence),
        workflow: { nextReviewStep: (cwd, pr, opts) => nextReviewStep(cwd, pr, { ...opts, pluginPin }) },
        uw: createInstalledUwReadPort({ cwd: ctx.cwd, readAuthor: automationLogin }),
        operations,
      })
      driverStarted = true
      const notify = terminalNotifier(pi, run, 'ci correction')
      const reporting = run.terminal.then(
        (terminal) =>
          notify(
            terminal.status === 'complete'
              ? `ci-correction ${run.runId} completed with confirmed record ${terminal.recordId}.`
              : `ci-correction ${run.runId} stopped: ${terminal.diagnostics.join(', ')}`,
          ),
        (error) =>
          notify(`ci-correction ${run.runId} failed: ${error instanceof Error ? error.message : String(error)}`),
      )
      ownReportingFixRun(pi, run, reporting, 'ci correction')
      return run
    })
  } finally {
    try {
      if (!driverStarted) {
        executionFence.seal()
        await executionFence.closeHostOperations()
      }
    } finally {
      releaseIngress()
    }
  }
}

export { dispatchAdmittedCiCorrection, dispatchDefaultFix }
