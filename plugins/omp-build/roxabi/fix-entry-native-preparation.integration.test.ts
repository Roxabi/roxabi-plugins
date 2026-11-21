import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { arrangeReviewFixture, seedReviewFixture } from '../testing/feature-review-fixture.ts'
import { isolatedPinSandbox } from '../testing/isolated-pin-sandbox.ts'
import { git, readSim } from '../testing/sandbox/sandbox-repository.ts'

const BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const authorization = createRequire(import.meta.url)('../vendor/kit-head-authorization/index.cjs') as {
  decode(body: string): { kind: string; source: string; lane: string; evidence: string; pullRequest: number } | null
}
const roots = new Set<string>()
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.clear()
})

it('does not publish a standalone correction when native action snapshot placement is unavailable', async () => {
  const { box, cwd } = arrangeReviewFixture()
  roots.add(box.root)
  const pin = isolatedPinSandbox(box)
  const control = path.join(box.root, 'pin-control.json')
  writeFileSync(control, JSON.stringify({ shared: pin.candidate }))
  box.env = { ...pin.env, PIN_CONTROL_FILE: control }
  await seedReviewFixture(box, cwd)

  // Both real snapshot destinations are unavailable: the configured artifacts root
  // and the linked worktree's fallback each have a file where a directory is needed.
  const artifacts = path.join(box.root, 'unavailable-artifacts')
  writeFileSync(artifacts, 'not a directory')
  const gitDir = git(box, cwd, ['rev-parse', '--absolute-git-dir'])
  writeFileSync(path.join(gitDir, 'omp-build'), 'not a directory')
  const before = readSim(box)
  const runner = path.resolve(import.meta.dirname, '../testing/fix-native-preparation-refusal-runner.ts')
  const run = spawnSync(BUN, [runner, cwd, artifacts], { cwd, env: box.env, encoding: 'utf8', timeout: 55_000 })
  expect(run.status, `${run.stderr}\n${run.stdout}`).toBe(0)
  const observed = JSON.parse(run.stdout)
  expect(observed.result).toEqual({ ok: false, diagnostics: ['snapshot-placement-unavailable'] })
  // The real admission mutex was acquired before native snapshot preparation refused.
  expect(observed.leaseAcquired).toBe(true)
  expect(observed.state).toMatchObject({
    rootBound: true,
    nativeEntered: false,
    planEntered: false,
    driver: 'nonterminal-result',
    publications: [],
  })
  expect(observed.host).toMatchObject({
    status: 'unknown',
    diagnostics: expect.arrayContaining(['snapshot-placement-partial']),
  })
  expect(observed.host.operations.filter((operation: { kind: string }) => operation.kind === 'snapshot')).toEqual([
    expect.objectContaining({ outcome: 'rejected' }),
    expect.objectContaining({ outcome: 'rejected' }),
  ])
  expect(observed.release).toEqual({ status: 'released' })
  expect(readFileSync(artifacts, 'utf8')).toBe('not a directory')
  expect(readFileSync(path.join(gitDir, 'omp-build'), 'utf8')).toBe('not a directory')
  const after = readSim(box)
  const content = (comments: { body: string; author: string }[] | undefined) =>
    comments?.map(({ body, author }) => ({ body, author }))
  expect(content(after.issues['42']?.comments)).toEqual(content(before.issues['42']?.comments))
  const priorPr = content(before.prs['7']?.comments)
  const currentPr = content(after.prs['7']?.comments)
  expect(priorPr).toBeDefined()
  expect(currentPr).toBeDefined()
  if (!priorPr || !currentPr) throw new Error('fixture-pr-comments-missing')
  expect(currentPr.slice(0, priorPr.length)).toEqual(priorPr)
  for (const comment of currentPr.slice(priorPr.length)) {
    expect(comment.author).toBe('operator')
    expect(authorization.decode(comment.body)).toMatchObject({
      kind: 'withdraw',
      source: 'revoke',
      lane: 'all',
      evidence: 'native lifecycle disarm',
      pullRequest: 7,
    })
  }
})
