import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { viewer } from '../dist/contracts.js'
import type { FeatureReviewFix } from '../roxabi/feature-contract.ts'
import { startAdmittedCiCorrection } from '../roxabi/fix-entry-ci.ts'
import { type FixRun, type FixStart, startDefaultFix } from '../roxabi/fix-entry-lifecycle.ts'
import type { CiCorrectionAdmission } from '../roxabi/fix-mandate-types.ts'
import { createInstalledUwReadPort } from '../roxabi/uw-read-port.ts'
import { nextReviewStep } from '../skills/feature/workflow-review-state.js'
import {
  createOmpFixPort,
  type FixHost,
  hasOwnedFixRun,
  ownedFixRunFor,
  ownFixRun,
  releaseOwnedFixRun,
  reportFeatureTerminalStatus,
} from './omp-controller'

async function dispatchDefaultFix(
  pi: FixHost,
  ctx: ExtensionContext,
  args: string,
  options: Partial<FeatureReviewFix> = {},
): Promise<FixStart> {
  const automationLogin = await viewer({ cwd: ctx.cwd })
  if (hasOwnedFixRun(pi)) throw new Error('fix-run-already-active')
  const run = startDefaultFix({
    cwd: ctx.cwd,
    args,
    reference: options.reference,
    reviewId: options.reviewId,
    scope: options.scope,
    requiredFeatureMandate: options.requiredFeatureMandate,
    contextWindow: typeof ctx.model?.contextWindow === 'number' ? ctx.model.contextWindow : undefined,
    native: createOmpFixPort(pi),
    workflow: { nextReviewStep },
    uw: createInstalledUwReadPort({ cwd: ctx.cwd, readAuthor: automationLogin }),
  })
  const notify = async (text: string): Promise<void> => {
    if (ownedFixRunFor(pi)?.run === run && ownedFixRunFor(pi)?.tearingDown) {
      console.error(`omp-build: fix run ${run.runId} ended during teardown: ${text}`)
      return
    }
    try {
      reportFeatureTerminalStatus(pi, text)
    } catch (error) {
      console.error(
        `omp-build: fix terminal notification failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  const reporting = run.completion.then(
    (result) =>
      notify(
        result.ok
          ? `/fix ${run.runId} completed with confirmed record ${result.value.recordId}.`
          : `/fix ${run.runId} stopped: ${result.diagnostics.join(', ')}`,
      ),
    (error) => notify(`/fix ${run.runId} failed: ${error instanceof Error ? error.message : String(error)}`),
  )
  const releaseOwned = async () => {
    const owned = ownedFixRunFor(pi)
    if (owned?.run !== run) return
    await owned.stopping
    releaseOwnedFixRun(pi, run)
  }
  const release = reporting.then(releaseOwned, releaseOwned)
  ownFixRun(pi, { run, reporting, release })
  return run.started
}

async function dispatchAdmittedCiCorrection(
  pi: FixHost,
  ctx: ExtensionContext,
  input: { reference: string; attributionRecordId: string; uw: CiCorrectionAdmission['uw'] },
): Promise<FixRun> {
  if (hasOwnedFixRun(pi)) throw new Error('fix-run-already-active')
  const automationLogin = await viewer({ cwd: ctx.cwd })
  const run = startAdmittedCiCorrection({
    cwd: ctx.cwd,
    reference: input.reference,
    attributionRecordId: input.attributionRecordId,
    expectedUw: input.uw,
    native: createOmpFixPort(pi),
    workflow: { nextReviewStep },
    uw: createInstalledUwReadPort({ cwd: ctx.cwd, readAuthor: automationLogin }),
  })
  const notify = async (text: string): Promise<void> => {
    if (ownedFixRunFor(pi)?.run === run && ownedFixRunFor(pi)?.tearingDown) {
      console.error(`omp-build: ci correction ${run.runId} ended during teardown: ${text}`)
      return
    }
    try {
      reportFeatureTerminalStatus(pi, text)
    } catch (error) {
      console.error(
        `omp-build: ci correction notification failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  const reporting = run.terminal.then(
    (terminal) =>
      notify(
        terminal.status === 'complete'
          ? `ci-correction ${run.runId} completed with confirmed record ${terminal.recordId}.`
          : `ci-correction ${run.runId} stopped: ${terminal.diagnostics.join(', ')}`,
      ),
    (error) => notify(`ci-correction ${run.runId} failed: ${error instanceof Error ? error.message : String(error)}`),
  )
  const releaseOwned = async () => {
    const owned = ownedFixRunFor(pi)
    if (owned?.run !== run) return
    await owned.stopping
    releaseOwnedFixRun(pi, run)
  }
  const release = reporting.then(releaseOwned, releaseOwned)
  ownFixRun(pi, { run, reporting, release })
  return run
}

export { dispatchAdmittedCiCorrection, dispatchDefaultFix }
