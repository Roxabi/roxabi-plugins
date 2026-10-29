import type { ActionInputs } from '../../engine/action-input-schema.ts'
import { installFixtureSdkSettings } from '../../testing/native-sdk-settings-fixture.ts'

const [cwd = '', raw = '{}', actionId = ''] = process.argv.slice(2)
await installFixtureSdkSettings(cwd)
// SDK settings must exist before the installed runtime loads its registry.
const { createInstalledUwOperations } = await import('../../roxabi/uw-installed-operations.ts')
const reviewed = JSON.parse(raw) as ActionInputs
const manifest = reviewed.manifest
const operations = await createInstalledUwOperations({
  cwd,
  operator: {
    async executeConfirmed() {
      throw new Error('unexpected-uw-write')
    },
  },
})
const result = await operations.replayActionInputs({
  reviewed,
  request: {
    actionId,
    purpose: manifest.purpose,
    subject: manifest.subject,
    code: manifest.code,
    stageSources: reviewed.stageSources,
    expandedContext: manifest.expandedContext,
    operands: manifest.operands,
  },
})
process.stdout.write(`${JSON.stringify(result)}\n`)
