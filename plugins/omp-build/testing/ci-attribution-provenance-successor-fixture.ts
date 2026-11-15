import { execFileSync, spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect } from 'vitest'
import type { ActionInputs } from '../engine/action-input-schema.ts'
import { appendApprovedReview, pullHistory, setFailedCi } from './feature-ci-review-fixture.ts'
import { arrangeReviewFixture, seedReviewFixture } from './feature-review-fixture.ts'
import { isolatedPinSandbox } from './isolated-pin-sandbox.ts'
import { readSim, writeSim } from './sandbox/sandbox-repository.ts'

const BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()

export async function createSuccessorFixture(roots: Set<string>) {
  const { box, cwd } = arrangeReviewFixture()
  roots.add(box.root)
  const pin = isolatedPinSandbox(box)
  const control = path.join(box.root, 'pin-control.json')
  writeFileSync(control, JSON.stringify({ shared: pin.candidate }))
  box.env = { ...pin.env, PIN_CONTROL_FILE: control }
  await seedReviewFixture(box, cwd)
  appendApprovedReview(box, cwd)
  setFailedCi(box)
  writeFileSync(control, '{}')
  const before = readSim(box)
  const prefixPath = path.resolve(import.meta.dirname, 'ci-attribution-provenance-prefix-runner.ts')
  const first = spawnSync(BUN, [prefixPath, cwd], { cwd, env: box.env, encoding: 'utf8', timeout: 55_000 })
  expect(first.status, `${first.stderr}\n${first.stdout}`).toBe(0)
  const firstOutput = JSON.parse(first.stdout) as { attribution: ActionInputs }
  const full = pullHistory(box)
  const old = full.operations.find(
    (operation) =>
      operation.record?.kind === 'action-receipt' &&
      operation.record.payload.action === 'attribute-ci' &&
      operation.record.payload.phase === 'result',
  )?.record
  if (old?.kind !== 'action-receipt' || old.payload.action !== 'attribute-ci' || old.payload.phase !== 'result')
    throw new Error('old-attribution-missing')
  const oldPayload = old.payload
  const prefixIds = new Set([old.recordId, old.payload.start.recordId])
  const partIds = new Set(
    full.operations
      .filter((operation) => operation.recordId && prefixIds.has(operation.recordId))
      .flatMap((operation) => operation.parts.map((part) => Number(part.nativeId) - 1)),
  )
  const afterFirst = readSim(box)
  const comments = afterFirst.prs['7']?.comments
  if (!comments) throw new Error('prefix-pr-missing')
  const retained = comments.filter((_comment, index) => partIds.has(index))
  if (retained.length === 0) throw new Error('prefix-attribution-comments-missing')
  writeSim(box, (state) => {
    Object.assign(state, before)
    for (const [number, issue] of Object.entries(state.issues)) {
      const captured = afterFirst.issues[number]
      if (!captured) throw new Error(`prefix-issue-missing:${number}`)
      issue.comments = captured.comments.slice(0, issue.comments.length)
    }
    for (const [number, pull] of Object.entries(state.prs)) {
      const captured = afterFirst.prs[number]
      if (!captured) throw new Error(`prefix-pull-missing:${number}`)
      pull.comments = captured.comments.slice(0, pull.comments.length)
    }
    const pull = state.prs['7']
    if (!pull) throw new Error('restored-pr-missing')
    pull.comments.push(...retained)
    state.nextCommentId = afterFirst.nextCommentId
  })
  return { box, cwd, pin, control, prefixPath, firstOutput, old: { ...old, payload: oldPayload } }
}
