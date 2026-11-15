import { reviewInitialData } from './feature-review-lifecycle.ts'
import { createReviewDriver } from './native-review-driver.ts'
import { installFixtureSdkSettings } from './native-sdk-settings-fixture.ts'

const cwd = process.argv[2]
if (!cwd) throw new Error('fixture-cwd-missing')
await installFixtureSdkSettings(cwd)
const driver = await createReviewDriver(cwd, 128_000, 'feature', true)
let after = driver.messages.length
const intake = driver.nextBatch(after)
await driver.settle(() => ({ attribution: 'change', evidence: null }))
await intake
after = driver.messages.length
const synthesis = driver.nextBatch(after)
await driver.settle((task) => reviewInitialData({ ...task, name: 'panel-ci' }))
await synthesis
process.stdout.write(`${JSON.stringify({ messages: driver.messages })}\n`)
process.exit(0)
