import type { NativePort } from '../roxabi/fix-contract.ts'
import { runAdmittedCiCorrectionEntry } from '../roxabi/fix-entry-ci.ts'
import { createIdentity } from '../roxabi/fix-entry-lifecycle.ts'
import { createInstalledUwOperations } from '../roxabi/uw-installed-operations.ts'
import { createInstalledUwReadPort } from '../roxabi/uw-read-port.ts'
import { nextReviewStep } from '../skills/feature/workflow-review-state.js'

const cwd = process.argv[2]
if (!cwd) throw new Error('fixture-cwd-missing')
const unexpected = (): never => {
  throw new Error('native-dispatch-before-ci-target-check')
}
const native: NativePort = { activate: unexpected, active: unexpected, stopOwned: unexpected, announce: unexpected }
const operations = await createInstalledUwOperations({ cwd, operator: { executeConfirmed: async () => unexpected() } })
const uw = createInstalledUwReadPort({ cwd })
const read = await uw.readUw({ repository: 'acme/app', target: 'acme/app#42' })
if (read.accepted.status !== 'accepted') throw new Error('fixture-accepted-uw-missing')
const result = await runAdmittedCiCorrectionEntry(
  {
    cwd,
    reference: '#42',
    attributionRecordId: 'fixture-attribution',
    native,
    workflow: { nextReviewStep },
    operations,
    uw,
    expectedUw: { ownSpec: read.accepted.value, children: [] },
  },
  createIdentity(),
  { signal: new AbortController().signal, uw: operations, onBatch: unexpected, onStarted: unexpected },
)
process.stdout.write(`${JSON.stringify(result)}\n`)
