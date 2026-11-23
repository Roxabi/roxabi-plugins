import { githubScope } from '../adapters/github/transport.ts'
import { canonicalValueDigest } from '../engine/action-input.ts'
import { buildRecord } from '../engine/record-construction.ts'
import type { DeliveryCode } from '../roxabi/delivery-action.ts'
import { actionRequest, confirmPreparedAction, uwSubject } from '../roxabi/delivery-action.ts'
import { readNativeCiFailureEvidence } from '../roxabi/feature-ci-evidence.ts'
import { defaultGh } from '../roxabi/feature-engine.ts'
import { createInstalledUwOperations } from '../roxabi/uw-installed-operations.ts'
import { reviewGraph } from './record-graphs.ts'

const [cwd, codeJson] = process.argv.slice(2)
if (!cwd || !codeJson) throw new Error('fixture-input-missing')
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
const review = await confirmPreparedAction(
  operations,
  actionRequest({ actionId: 'historical-review', purpose: 'review', subject, code }),
)
if (!review.ok) throw new Error(JSON.stringify(review))
const historicalReview = reviewGraph({
  prefix: 'historical-review',
  scope,
  head: code.head,
  inputs: review.value.inputs,
})
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
if (!start.ok) throw new Error(JSON.stringify(start))
if (!result.ok) throw new Error(JSON.stringify(result))
process.stdout.write(
  JSON.stringify({
    records: [...historicalReview.records, start.value, result.value],
    ref: {
      source: 'record',
      record: { scope, kind: 'action-receipt', recordId: resultId },
      selector: '/payload',
      digest: canonicalValueDigest(result.value.payload),
    },
  }),
)
