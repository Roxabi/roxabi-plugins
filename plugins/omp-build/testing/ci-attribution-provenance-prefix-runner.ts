import { githubScope } from '../adapters/github/transport.ts'
import { canonicalValueDigest } from '../engine/action-input.ts'
import { buildRecord } from '../engine/record-construction.ts'
import type { DeliveryCode } from '../roxabi/delivery-action.ts'
import { actionRequest, confirmPreparedAction, uwSubject } from '../roxabi/delivery-action.ts'
import { readNativeCiFailureEvidence } from '../roxabi/feature-ci-evidence.ts'
import { defaultGh } from '../roxabi/feature-engine.ts'
import { createGitHubRecordPublisher } from '../roxabi/github-publisher.ts'
import { createInstalledUwOperations } from '../roxabi/uw-installed-operations.ts'
import { installFixtureSdkSettings } from './native-sdk-settings-fixture.ts'

const [cwd, codeJson] = process.argv.slice(2)
if (!cwd || !codeJson) throw new Error('fixture-input-missing')
await installFixtureSdkSettings(cwd)
const { createReviewDriver } = await import('./native-review-driver.ts')
const { reviewInitialData } = await import('./feature-review-lifecycle.ts')
const { reviewDecision } = await import('./feature-review-synthesis-sources.ts')
const driver = await createReviewDriver(cwd)
await driver.settle(reviewInitialData)
await driver.settle((task) => reviewDecision(task.task))
const code = JSON.parse(codeJson) as DeliveryCode
const gh = defaultGh()
const scope = githubScope('acme/app', 7)
const uw = githubScope('acme/app', 42)
const subject = uwSubject(uw, scope)
const actionId = 'historical-attribution'
const operations = await createInstalledUwOperations({
  cwd,
  operator: {
    async executeConfirmed() {
      throw new Error('Unexpected operator action')
    },
  },
})
const read = await operations.readUw(uw)
const mandate = read.histories
  .flatMap((entry) => entry.operations)
  .find((entry) => entry.record?.kind === 'mandate' && entry.record.target === uw.target)?.record
if (!mandate) throw new Error('fixture-mandate-missing')
const live = await readNativeCiFailureEvidence(cwd, scope.repository, code.head, scope, { gh })
if (!live.ok) throw new Error(JSON.stringify(live))
const exactInputs = {
  candidateGitSHA: code.head,
  scope,
  failedChecks: live.failedChecks,
  failures: live.failures,
  evidenceDigest: live.evidenceDigest,
}
const prepared = await confirmPreparedAction(
  operations,
  actionRequest({
    actionId,
    purpose: 'attribute-ci',
    subject,
    code,
    operands: { action: 'attribute-ci', exactInputs },
  }),
)
if (!prepared.ok) throw new Error(JSON.stringify(prepared))
const common = {
  format: 'omp-build-action-receipt/2' as const,
  action: 'attribute-ci' as const,
  actionId,
  mandate: { kind: 'mandate' as const, scope: uw, recordId: mandate.recordId },
  inputs: prepared.value.inputs,
  exactInputs,
}
const publisher = createGitHubRecordPublisher(scope, { cwd, gh }, null)
const records = { version: 1 as const, ...scope, runId: actionId, kind: 'action-receipt' as const }
const startId = `${actionId}-start`
const resultId = `${actionId}-result`
const start = buildRecord({
  ...records,
  recordId: startId,
  operationId: startId,
  payload: { ...common, phase: 'start' },
})
const result = buildRecord({
  ...records,
  recordId: resultId,
  operationId: resultId,
  payload: {
    ...common,
    phase: 'result',
    start: { kind: 'action-receipt', scope, recordId: startId },
    native: { completion: 'completed', strict: 'valid', raw: null },
    structured: { attribution: 'change', evidence: null },
    admission: null,
    diagnostics: [],
  },
})
for (const record of [start, result]) {
  if (!record.ok) throw new Error(JSON.stringify(record))
  const written = await publisher.publish(
    record.value,
    read.histories.filter((entry) => entry.source.scope.target !== scope.target),
  )
  if (!written.ok) throw new Error(JSON.stringify(written))
}
if (!result.ok) throw new Error('fixture-result-missing')
const intake = await confirmPreparedAction(
  operations,
  actionRequest({
    actionId: 'attribution-matrix-intake',
    purpose: 'correction',
    subject,
    code,
    stageSources: [
      {
        source: 'record',
        record: { scope, kind: 'action-receipt', recordId: resultId },
        selector: '/payload',
        digest: canonicalValueDigest(result.value.payload),
      },
    ],
  }),
)
if (!intake.ok) throw new Error(JSON.stringify(intake))
process.stdout.write(JSON.stringify({ intake: intake.value.inputs }))
