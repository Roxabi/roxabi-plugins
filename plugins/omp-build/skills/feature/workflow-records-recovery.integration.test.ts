import { execFileSync, spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { arrangeReviewFixture, seedReviewFixture } from '../../testing/feature-review-fixture.ts'
import { seedFixRecoveryPrefix } from '../../testing/fix-recovery-prefix-fixture.ts'
import { writeSim } from '../../testing/sandbox/sandbox-repository.ts'
import { readReviewRecords } from './workflow-records.js'

const bun = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const roots = new Set<string>()
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.clear()
})

it('projects only an authenticated neutral close before hosted review admission', async () => {
  const { box, cwd } = arrangeReviewFixture()
  roots.add(box.root)
  await seedReviewFixture(box, cwd)
  const fixture = await seedFixRecoveryPrefix(box, cwd)
  const runner = path.resolve(import.meta.dirname, '../../testing/fix-recovery-prefix-reader.ts')
  const run = spawnSync(bun, [runner, cwd, 'control'], { cwd, env: box.env, encoding: 'utf8', timeout: 55_000 })
  expect(run.status, `${run.stderr}\n${run.stdout}`).toBe(0)
  const control = JSON.parse(run.stdout)
  expect(control).toMatchObject({ kind: 'fix-recovery', payload: { phase: 'close-publication' } })
  const post = (body: string) =>
    execFileSync('gh', ['api', '--method', 'POST', 'repos/acme/app/issues/7/comments', '-f', `body=${body}`], {
      cwd,
      env: box.env,
      encoding: 'utf8',
    })
  for (const body of fixture.frame(control)) post(body)
  const gh = async (dir: string, args: string[]) =>
    execFileSync('gh', args, { cwd: dir, env: box.env, encoding: 'utf8' })
  const closed = await readReviewRecords(cwd, 7, { gh })
  expect(closed, JSON.stringify(closed)).toMatchObject({ ok: true })

  const firstPart = fixture.framedSource[0]
  if (firstPart === undefined) throw new Error('fixture-source-part-missing')
  const unrelated = firstPart
    .replace(`id=${fixture.source.recordId} `, 'id=unrelated-source ')
    .replace(`operationId=${fixture.source.operationId} `, 'operationId=unrelated-operation ')
  expect(unrelated).not.toBe(fixture.framedSource[0])
  writeSim(box, (state) => {
    const pr = state.prs['7']
    if (!pr) throw new Error('fixture-pr-missing')
    pr.comments.push({
      id: 39000,
      author: 'operator',
      body: unrelated,
      createdAt: fixture.date,
      updatedAt: fixture.date,
    })
  })
  const corrupt = await readReviewRecords(cwd, 7, { gh }).catch(() => ({ ok: false }))
  expect(corrupt.ok).toBe(false)
})
