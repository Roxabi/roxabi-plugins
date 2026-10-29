import { chmodSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { installFixtureSdkSettings } from '../../testing/native-sdk-settings-fixture.ts'

const cwd = process.argv[2] ?? ''
await installFixtureSdkSettings(cwd)
// Fixture SDK settings must be installed before loading the native runtime.
const { loadFeatureWorkflow } = await import('../../roxabi/feature-loader.ts')
const { createInstalledUwOperations } = await import('../../roxabi/uw-installed-operations.ts')
const { createInstalledUwReadPort } = await import('../../roxabi/uw-read-port.ts')
const uw = await createInstalledUwOperations({
  cwd,
  operator: {
    async executeConfirmed() {
      throw new Error('unexpected-uw-write')
    },
  },
})
const workflow = await loadFeatureWorkflow()
const result = await workflow.continueFeature({
  cwd,
  reference: '#42',
  control: 'continue',
  principal: false,
  read: createInstalledUwReadPort({ cwd }),
  uw,
})
if (result.kind !== 'action' || result.node !== 'assess-spec') throw new Error(JSON.stringify(result))
const snapshot = result.followUp.tasks.tasks[0].action.snapshot
const before = await uw.verifyAction(snapshot)
const file = join(dirname(snapshot.indexPath), 'action/exact-inputs.json')
chmodSync(file, 0o644)
writeFileSync(file, '{"tampered":true}')
chmodSync(file, 0o444)
const after = await uw.verifyAction(snapshot)
process.stdout.write(`${JSON.stringify({ before, after })}\n`)
