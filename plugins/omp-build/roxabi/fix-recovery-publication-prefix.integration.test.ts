import { execFileSync, spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { pullHistory } from '../testing/feature-ci-review-fixture.ts'
import { arrangeReviewFixture, seedReviewFixture } from '../testing/feature-review-fixture.ts'
import { seedFixRecoveryPrefix } from '../testing/fix-recovery-prefix-fixture.ts'

const BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const roots = new Set<string>()
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.clear()
})

it('exposes a settled torn-source publication prefix without inventing a request or decision', async () => {
  const { box, cwd } = arrangeReviewFixture()
  roots.add(box.root)
  await seedReviewFixture(box, cwd)
  const runner = path.resolve(import.meta.dirname, '../testing/fix-recovery-prefix-reader.ts')
  const read = () => {
    const run = spawnSync(BUN, [runner, cwd], { cwd, env: box.env, encoding: 'utf8', timeout: 55_000 })
    expect(run.status, `${run.stderr}\n${run.stdout}`).toBe(0)
    return JSON.parse(run.stdout)
  }
  const { source, opened, settled, interrupted, baseline } = await seedFixRecoveryPrefix(box, cwd)
  expect(baseline).toMatchObject({ accepted: 'accepted', observation: 'complete' })
  expect(
    pullHistory(box).operations.some((item) => item.record?.kind === 'fix-request' || item.record?.kind === 'decision'),
  ).toBe(false)
  const observed = read()
  // Ordinary completeness remains blocked by the torn C0 until a confirmed recovery control exists.
  expect(observed, JSON.stringify(observed)).toMatchObject({
    accepted: 'refused',
    observation: 'incomplete',
    admission: { framed: false, deliverable: false },
    fixRecovery: { status: 'interrupted', owner: opened, settled, phase: interrupted },
  })
  expect(observed.observationDiagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: 'incomplete',
        message: expect.stringContaining(source.operationId),
      }),
    ]),
  )
})
