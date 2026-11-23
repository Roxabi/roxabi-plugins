import { reviewInitialData } from './feature-review-lifecycle.ts'
import { createReviewDriver } from './native-review-driver.ts'
import { installFixtureSdkSettings } from './native-sdk-settings-fixture.ts'

const cwd = process.argv[2]
if (!cwd) throw new Error('fixture-cwd-missing')
await installFixtureSdkSettings(cwd)
const driver = await createReviewDriver(cwd, 128_000, 'fix-pr')
const synthesis = driver.nextBatch(driver.messages.length)
await driver.settle((task) => reviewInitialData({ ...task, name: 'panel-fixture-intake' }))
await synthesis
process.stdout.write(`${JSON.stringify({ messages: driver.messages })}\n`)
process.exit(0)
