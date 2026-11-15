import { readFileSync, watch } from 'node:fs'
import { basename, dirname } from 'node:path'
import { decodeHistory } from '../adapters/github/history-codec.ts'
import type { State } from '../skills/feature/testing/gh-simulator/sim-types.ts'
import { installFixtureSdkSettings } from './native-sdk-settings-fixture.ts'

const cwd = process.argv[2]
if (!cwd) throw new Error('fixture-cwd-missing')
function fixtureStatePath(): string {
  const value = process.env.GH_SIM_STATE
  if (!value) throw new Error('fixture-gh-state-missing')
  return value
}
const statePath = fixtureStatePath()
await installFixtureSdkSettings(cwd)
const { createReviewDriver } = await import('./native-review-driver.ts')
const driver = await createReviewDriver(cwd, 128_000, 'feature', true)
const attribution = driver.controller.active()
if (attribution === null) throw new Error(`attribution-batch-missing: ${JSON.stringify(driver.messages)}`)
await driver.settle(() => ({ attribution: 'change', evidence: null }))
const fix = driver.fixRun()
const admitted = Promise.withResolvers<void>()
function hasPublishedRequest(): boolean {
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as State
  const comments = state.prs['7']?.comments ?? []
  const history = decodeHistory({
    scope: { repository: 'acme/app', target: 'acme/app#7' },
    expectedAuthor: 'operator',
    stopAuthor: null,
    complete: true,
    diagnostics: [],
    comments: comments.map((comment, index) => ({
      locator: `acme/app#7:${index + 1}`,
      nativeId: String(index + 1),
      body: comment.body,
      author: comment.author,
      createdAt: comment.createdAt ?? null,
      updatedAt: comment.updatedAt ?? null,
    })),
  })
  return history.operations.some(
    (operation) => operation.status === 'complete' && operation.record?.kind === 'fix-request',
  )
}
const watcher = watch(dirname(statePath), (_event, file) => {
  if (file === basename(statePath) && hasPublishedRequest()) admitted.resolve()
})
const alreadyPublished = hasPublishedRequest()
if (alreadyPublished) admitted.resolve()
try {
  if (!alreadyPublished && fix === undefined)
    throw new Error(`ci-correction-not-started: ${JSON.stringify(driver.messages)}`)
  await Promise.race([
    admitted.promise,
    ...(fix === undefined
      ? []
      : [
          fix.terminal.then((terminal) => {
            if (!hasPublishedRequest())
              throw new Error(
                `ci-correction-before-admission: ${JSON.stringify({ terminal, messages: driver.messages })}`,
              )
          }),
        ]),
  ])
} finally {
  watcher.close()
}
process.stdout.write(
  `${JSON.stringify({
    attribution: attribution.tasks.tasks.map((task) => ({ name: task.name, agent: task.agent })),
    messages: driver.messages,
  })}\n`,
)
process.exit(0)
