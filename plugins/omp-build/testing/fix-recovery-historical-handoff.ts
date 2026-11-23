import { viewer } from '../dist/contracts.js'
import { createPreparationCohort } from '../host/preparation-cohort.ts'
import { createHostUwOperations } from '../omp/host-uw-operations.ts'
import { createOmpFixPort, type OmpBuildExtensionApi, ownFixRun } from '../omp/omp-controller.ts'
import { finishOwnedFixRun, observeFixRelease } from '../omp/omp-fix-release.ts'
import { createOperatorConfirmation } from '../omp/omp-operator-confirmation.ts'
import { captureNativeRootLifetime } from '../omp/review-runtime/native-sdk-adapter.ts'
import { startDefaultFix } from '../roxabi/fix-entry-lifecycle.ts'
import { FixExecutionFence } from '../roxabi/fix-execution-fence.ts'
import { createInstalledUwReadPort } from '../roxabi/uw-read-port.ts'
import { nextReviewStep } from '../skills/feature/workflow-review-state.js'

/** Exercises the durable writer at the removed review→Fix handoff, not today's standalone `/fix`. */
export default function historicalReviewHandoff(pi: OmpBuildExtensionApi): void {
  pi.registerCommand('fixture-historical-review-fix', {
    description: 'Write a historical review-bound request through the real Fix fence',
    async handler(reviewId, ctx) {
      const cohort = createPreparationCohort()
      const fence = new FixExecutionFence()
      fence.bindCohort(cohort)
      await cohort.run(async () => {
        const root = await fence.trackIngress(() => captureNativeRootLifetime(ctx))
        if (root === null) throw new Error('historical-fix-root-unavailable')
        fence.bindRoot(() => root.current(), root.lifetime)
        const readAuthor = await fence.trackIngress(() => viewer({ cwd: ctx.cwd }))
        const operations = await fence.trackIngress(() => createHostUwOperations(ctx, createOperatorConfirmation(ctx)))
        fence.closeIngress()
        const run = startDefaultFix({
          cwd: ctx.cwd,
          reference: '#7',
          scope: 'Follow up on the confirmed review',
          reviewId,
          contextWindow: ctx.model?.contextWindow ?? undefined,
          native: createOmpFixPort(pi, fence),
          workflow: { nextReviewStep },
          uw: createInstalledUwReadPort({ cwd: ctx.cwd, readAuthor }),
          operations,
        })
        const reporting = run.completion.then(() => undefined)
        const release = reporting.then(() => finishOwnedFixRun(pi, run, fence, 'historical fix'))
        observeFixRelease(release)
        ownFixRun(pi, { run, reporting, release })
        await run.started
      })
    },
  })
}
