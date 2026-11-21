import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { validateRecordGraph } from '../dist/contracts.js'
import { createPreparationCohort } from '../host/preparation-cohort.ts'
import { claimFixIngress, createOmpFixPort } from '../omp/omp-controller.ts'
import { captureNativeRootLifetime } from '../omp/review-runtime/native-sdk-adapter.ts'
import { readDecodedHistory } from '../roxabi/feature-context.ts'
import { defaultGh } from '../roxabi/feature-engine.ts'
import { reconstructFixCheckpoint } from '../roxabi/fix-checkpoint-state.ts'
import { admitAttributedCiCorrection } from '../roxabi/fix-ci-admission.ts'
import type { FixActionResult, FixRecord, NativePort } from '../roxabi/fix-contract.ts'
import { startAdmittedCiCorrection } from '../roxabi/fix-entry-ci.ts'
import { FixExecutionFence } from '../roxabi/fix-execution-fence.ts'
import { withRoxabiGitHubPolicy } from '../roxabi/github-policy.ts'
import { createInstalledUwOperations } from '../roxabi/uw-installed-operations.ts'
import { createInstalledUwReadPort } from '../roxabi/uw-read-port.ts'
import { nextReviewStep } from '../skills/feature/workflow-review-state.js'
import { createExtensionApiStub } from './extension-api-stub.ts'
import { REVIEW_BRANCH } from './feature-review-fixture.ts'
import { createRecoveryTestRoot } from './fix-recovery-real-root.ts'

const cwd = process.argv[2]
const raw = process.argv[3]
if (!cwd || !raw) throw new Error('race-fixture-input-missing')
const input = JSON.parse(raw) as { recordId: string; head: string; base: string }
const scope = { repository: 'acme/app', target: 'acme/app#7' }
const gh = defaultGh()
const options = withRoxabiGitHubPolicy({ cwd, gh })
const uw = createInstalledUwReadPort(options)
const operations = await createInstalledUwOperations({
  cwd,
  gh,
  operator: {
    async executeConfirmed() {
      throw new Error('unexpected-operator-action')
    },
  },
})
const readHistory = async () => {
  const result = await readDecodedHistory(scope, cwd, gh)
  if (!result.ok) throw new Error(`race-history:${result.reason}`)
  return result.history
}
const workflow = {
  nextReviewStep: (directory: string, pr: number, step: { ciFailed?: boolean; reviewing?: boolean }) =>
    nextReviewStep(directory, pr, { ...step, gh }),
}
const admission = await admitAttributedCiCorrection({
  cwd,
  target: {
    ...scope,
    number: 7,
    kind: 'pull-request',
    state: 'open',
    candidateGitSHA: input.head,
    baseGitSHA: input.base,
  },
  uw,
  branch: REVIEW_BRANCH,
  base: 'main',
  attributionRecordId: input.recordId,
  workflow,
  options,
  readHistory,
})
if (!admission.ok || admission.value.status !== 'attributed-correction')
  throw new Error(`race-initial-admission:${JSON.stringify(admission)}`)
const admitted = admission.value
let injected = false
let before: Awaited<ReturnType<typeof readHistory>> | undefined
const racingOperations = {
  ...operations,
  async readUw(subject: Parameters<typeof operations.readUw>[0]) {
    if (!injected) {
      injected = true
      const successor = spawnSync(
        process.execPath,
        [new URL('./ci-attribution-provenance-successor-runner.ts', import.meta.url).pathname, cwd],
        {
          cwd,
          env: process.env,
          encoding: 'utf8',
          timeout: 55_000,
        },
      )
      if (successor.status !== 0) throw new Error(`race-successor:${successor.stderr}\n${successor.stdout}`)
      before = await readHistory()
    }
    return operations.readUw(subject)
  },
}
const home = process.env.HOME
const ghConfigDir = process.env.GH_CONFIG_DIR
const ghSimulatorState = process.env.GH_SIM_STATE
if (!home || !ghConfigDir || !ghSimulatorState) throw new Error('race-sandbox-environment-missing')
const root = await createRecoveryTestRoot({
  cwd,
  agentDir: path.join(home, 'race-agent'),
  sandboxHome: home,
  ghConfigDir,
  ghSimulatorState,
  credential: 'fixture-credential',
  responses: [],
  agentModelOverrides: {},
  onApproval: async () => 'deny',
  onConfirmation: async () => 'refuse',
})
const ctx = {
  agent: { kind: 'main' as const, id: root.ref.id, name: 'main', depth: 0 },
  cwd,
  sessionManager: root.session.sessionManager,
  modelRegistry: root.session.modelRegistry,
}
const api = createExtensionApiStub()
const cohort = createPreparationCohort()
const fence = new FixExecutionFence()
fence.bindCohort(cohort)
let dispatches = 0
let result: FixActionResult<FixRecord>
try {
  const releaseIngress = claimFixIngress(api)
  try {
    result = await cohort.run(async () => {
      const captured = await fence.trackIngress(() => captureNativeRootLifetime(ctx as never))
      if (captured === null) throw new Error('race-root-unavailable')
      fence.bindRoot(captured.current, captured.lifetime)
      const port = createOmpFixPort(api, fence)
      const native: NativePort = {
        ...port,
        activate: () => {
          dispatches++
          throw new Error('unexpected-native-dispatch')
        },
        announce: async () => {
          dispatches++
          throw new Error('unexpected-native-announcement')
        },
      }
      fence.closeIngress()
      const run = startAdmittedCiCorrection({
        cwd,
        reference: '#7',
        attributionRecordId: input.recordId,
        native,
        workflow,
        operations: racingOperations,
        uw,
        expectedUw: admitted.uw,
        github: options,
        gh,
      })
      const outcome = await run.completion
      await run.driverTerminated
      await fence.closeHostOperations()
      const settled = await fence.settleInterruptedOwner()
      if (!settled.ok) throw new Error(`race-owner-settlement:${JSON.stringify(settled)}`)
      if (fence.destinationLeaseFacts() !== null) {
        const released = await fence.releaseDestinationLease()
        if (released.status !== 'released') throw new Error(`race-lease-release:${JSON.stringify(released)}`)
      }
      return outcome
    })
  } finally {
    releaseIngress()
  }
} finally {
  await root.dispose()
}
if (!before) throw new Error(`race-injection-not-reached:${JSON.stringify(result)}`)
const after = await readHistory()
process.stdout.write(
  `${JSON.stringify({
    result,
    dispatches,
    initialMandate: admitted.mandateRecordId,
    before: {
      checkpoint: reconstructFixCheckpoint(before),
      graph: validateRecordGraph(before),
      records: before.operations.map((operation) => operation.record),
    },
    after: {
      checkpoint: reconstructFixCheckpoint(after),
      graph: validateRecordGraph(after),
      records: after.operations.map((operation) => operation.record),
    },
  })}\n`,
)
