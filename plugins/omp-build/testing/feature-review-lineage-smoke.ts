import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { arrangeReviewFixture, seedReviewFixture } from './feature-review-fixture.ts'

const { box, cwd } = arrangeReviewFixture()
let success = false
try {
  await seedReviewFixture(box, cwd)
  const runner = path.resolve(import.meta.dirname, 'feature-recovery-runner.ts')
  const result = spawnSync(process.execPath, [runner, 'omp-review-lineage', cwd, '{}'], {
    cwd,
    env: box.env,
    encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(`lineage runner failed: ${result.stderr}\n${result.stdout}`)
  const observed = JSON.parse(result.stdout) as {
    captures: Array<{ head: string; fingerprint: string; causes: string[] }>
    expected: string[][]
    roots: Array<{ id: string; head: string; fingerprint: string }>
    reviews: number
    step: { action: string; reason: string }
    before: number
    after: number
    inventoriesBefore: string[]
    inventoriesAfter: string[]
    activeBefore: unknown
    activeAfter: unknown
    timings: Array<{ phase: string; ms: number }>
  }
  assert.equal(observed.captures.length, 3)
  assert.equal(new Set(observed.captures.map((capture) => capture.head)).size, 3)
  assert.equal(new Set(observed.captures.map((capture) => capture.fingerprint)).size, 3)
  assert.equal(observed.roots.length, 3)
  assert.equal(new Set(observed.roots.map((root) => root.id)).size, 3)
  assert.deepEqual(
    observed.roots.map(({ head, fingerprint }) => ({ head, fingerprint })),
    observed.captures.map(({ head, fingerprint }) => ({ head, fingerprint })),
  )
  assert.equal(observed.expected.length, 2)
  for (const [index, prior] of observed.expected.entries()) {
    assert.ok(prior.length > 0)
    for (const id of prior) assert.ok(observed.captures[index + 1]?.causes.includes(id))
  }
  assert.equal(observed.reviews, 3)
  assert.equal(observed.step.action, 'stop')
  assert.equal(observed.step.reason, 'review-bound')
  assert.equal(observed.before, 3)
  assert.equal(observed.after, observed.before)
  assert.deepEqual(observed.inventoriesAfter, observed.inventoriesBefore)
  assert.equal(observed.activeBefore, null)
  assert.equal(observed.activeAfter, null)
  success = true
  process.stdout.write(`${JSON.stringify(observed)}\n`)
} finally {
  if (success) rmSync(box.root, { recursive: true, force: true })
  else process.stderr.write(`retained fixture: ${box.root}\n`)
}
