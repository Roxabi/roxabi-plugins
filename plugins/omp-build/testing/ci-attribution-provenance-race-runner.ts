import { spawnSync } from 'node:child_process'
import { validateRecordGraph } from '../dist/contracts.js'
import { readDecodedHistory } from '../roxabi/feature-context.ts'
import { defaultGh } from '../roxabi/feature-engine.ts'
import { reconstructFixCheckpoint } from '../roxabi/fix-checkpoint-state.ts'
import { admitAttributedCiCorrection } from '../roxabi/fix-ci-admission.ts'
import type { NativePort } from '../roxabi/fix-contract.ts'
import { startAdmittedCiCorrection } from '../roxabi/fix-entry-ci.ts'
import { withRoxabiGitHubPolicy } from '../roxabi/github-policy.ts'
import { createInstalledUwOperations } from '../roxabi/uw-installed-operations.ts'
import { createInstalledUwReadPort } from '../roxabi/uw-read-port.ts'
import { nextReviewStep } from '../skills/feature/workflow-review-state.js'
import { REVIEW_BRANCH } from './feature-review-fixture.ts'

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
let dispatches = 0
const native: NativePort = {
  active: () => null,
  activate: () => {
    dispatches++
    throw new Error('unexpected-native-dispatch')
  },
  announce: async () => {
    dispatches++
    throw new Error('unexpected-native-announcement')
  },
  stopOwned: async () => {
    throw new Error('unexpected-native-stop')
  },
}
const run = startAdmittedCiCorrection({
  cwd,
  reference: '#7',
  attributionRecordId: input.recordId,
  native,
  workflow,
  operations: racingOperations,
  uw,
  expectedUw: admission.value.uw,
  github: options,
  gh,
})
const result = await run.completion
if (!before) throw new Error(`race-injection-not-reached:${JSON.stringify(result)}`)
const after = await readHistory()
process.stdout.write(
  `${JSON.stringify({
    result,
    dispatches,
    initialMandate: admission.value.mandateRecordId,
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
