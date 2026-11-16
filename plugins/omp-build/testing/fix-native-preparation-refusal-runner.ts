import { createPreparationCohort } from '../host/preparation-cohort.ts'
import type { NativePort } from '../roxabi/fix-contract.ts'
import { startDefaultFix } from '../roxabi/fix-entry-lifecycle.ts'
import { defaultGh } from '../roxabi/fix-entry-target-core.ts'
import { FixExecutionFence } from '../roxabi/fix-execution-fence.ts'
import { withRoxabiGitHubPolicy } from '../roxabi/github-policy.ts'
import { createInstalledUwOperations } from '../roxabi/uw-installed-operations.ts'
import { createInstalledUwReadPort } from '../roxabi/uw-read-port.ts'
import { nextReviewStep } from '../skills/feature/workflow-review-state.js'

const cwd = process.argv[2]
const artifactsDir = process.argv[3]
if (!cwd || !artifactsDir) throw new Error('fixture-input-missing')
const unexpected = (): never => {
  throw new Error('unexpected-native-dispatch')
}
const cohort = createPreparationCohort()
const fence = new FixExecutionFence()
fence.bindCohort(cohort)
// This fixture binds a controlled root, not an SDK-registered root.
fence.bindRoot(() => true, {
  agentId: 'fixture-agent',
  registryGeneration: 1,
  sessionId: 'fixture-session',
  providerSessionId: 'fixture-provider-session',
})
const output = await cohort.run(async () => {
  const gh = defaultGh
  const github = withRoxabiGitHubPolicy({ cwd, gh })
  const operations = await fence.trackIngress(() =>
    createInstalledUwOperations({
      cwd,
      gh,
      artifactsDir,
      operator: { executeConfirmed: async () => unexpected() },
    }),
  )
  fence.closeIngress()
  const native: NativePort = {
    activate: unexpected,
    active: unexpected,
    stopOwned: unexpected,
    announce: unexpected,
    executionFence: fence,
  }
  const run = startDefaultFix({
    cwd,
    reference: '#42',
    args: 'correct the issue',
    native,
    workflow: { nextReviewStep },
    operations,
    uw: createInstalledUwReadPort(github),
    github,
    gh,
  })
  const result = await run.completion
  await run.driverTerminated
  const leaseAcquired = fence.destinationLeaseFacts() !== null
  const state = fence.snapshot()
  const host = await fence.closeHostOperations()
  const release = leaseAcquired ? await fence.releaseDestinationLease() : null
  return { result, leaseAcquired, state, host, release }
})
process.stdout.write(`${JSON.stringify(output)}\n`)
