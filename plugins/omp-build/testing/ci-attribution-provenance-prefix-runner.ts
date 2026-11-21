import type { NativeTask } from '../omp/review-runtime/contracts.ts'
import { reviewInitialData } from './feature-review-lifecycle.ts'
import { createReviewDriver } from './native-review-driver.ts'
import { installFixtureSdkSettings } from './native-sdk-settings-fixture.ts'

const cwd = process.argv[2]
if (!cwd) throw new Error('fixture-cwd-missing')
await installFixtureSdkSettings(cwd)
const driver = await createReviewDriver(cwd, 128_000, 'feature', true)
let attribution: NativeTask['action']['inputs'] | undefined
const next = driver.nextBatch(driver.messages.length)
await driver.settle((task) => {
  if (task.action.inputs.manifest.purpose !== 'attribute-ci')
    throw new Error(`expected-attribute-ci:${task.action.inputs.manifest.purpose}`)
  attribution = task.action.inputs
  return { attribution: 'change', evidence: null }
})
await next
if (!attribution) throw new Error('attribution-task-missing')
let intake: NativeTask['action']['inputs'] | undefined
if (process.argv[3] === 'capture-intake') {
  const synthesis = driver.nextBatch(driver.messages.length)
  await driver.settle((task) => {
    if (task.action.inputs.manifest.purpose !== 'correction' || task.name !== 'ci-correction-intake')
      throw new Error(`expected-ci-correction-intake:${task.name}:${task.action.inputs.manifest.purpose}`)
    intake = task.action.inputs
    return reviewInitialData({ ...task, name: 'panel-ci' })
  })
  await synthesis
}
process.stdout.write(`${JSON.stringify({ attribution, intake, messages: driver.messages })}\n`)
process.exit(0)
