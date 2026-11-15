import { execFileSync, spawnSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { canonicalValueDigest } from '../../engine/action-input.ts'
import type { ActionInputs } from '../../engine/action-input-schema.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import { reconstructFixCheckpoint } from '../../roxabi/fix-checkpoint-state.ts'
import type { RecordInputRef } from '../../roxabi/uw-action-contract.ts'
import { appendApprovedReview, pullHistory, setFailedCi } from '../../testing/feature-ci-review-fixture.ts'
import { arrangeReviewFixture, seedReviewFixture } from '../../testing/feature-review-fixture.ts'
import { isolatedPinSandbox } from '../../testing/isolated-pin-sandbox.ts'
import { readSim, writeSim } from '../../testing/sandbox/sandbox-repository.ts'

const BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const roots = new Set<string>()
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.clear()
})

it('refuses stale attribution at prepare and reattributes under the real successor mandate', async () => {
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
  const prefixPath = path.resolve(import.meta.dirname, '../../testing/ci-attribution-provenance-prefix-runner.ts')
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
  writeFileSync(control, JSON.stringify({ shared: pin.candidate }))
  const racePath = path.resolve(import.meta.dirname, '../../testing/ci-attribution-provenance-race-runner.ts')
  const race = spawnSync(
    BUN,
    [
      racePath,
      cwd,
      JSON.stringify({
        recordId: old.recordId,
        head: firstOutput.attribution.manifest.code.head,
        base: firstOutput.attribution.manifest.code.base,
      }),
    ],
    { cwd, env: box.env, encoding: 'utf8', timeout: 55_000 },
  )
  expect(race.status, `${race.stderr}\n${race.stdout}`).toBe(0)
  const raced = JSON.parse(race.stdout) as {
    result: { ok: boolean; diagnostics?: string[] }
    dispatches: number
    initialMandate: string
    before: { checkpoint: unknown; graph: { ok: boolean }; records: Array<CanonicalRecord | null> }
    after: { checkpoint: unknown; graph: { ok: boolean }; records: Array<CanonicalRecord | null> }
  }
  expect(raced.initialMandate).toBe(old.payload.mandate.recordId)
  expect(raced.result).toEqual({ ok: false, diagnostics: ['prepare-action-unavailable'] })
  expect(raced.dispatches).toBe(0)
  expect(raced.before.graph.ok).toBe(true)
  expect(raced.after.graph.ok).toBe(true)
  expect(raced.after.checkpoint).toEqual(raced.before.checkpoint)
  expect(raced.after.records).toEqual(raced.before.records)
  expect(raced.after.records.filter((record) => record?.kind === 'fix-request')).toHaveLength(0)
  expect(
    raced.after.records.filter(
      (record) => record?.kind === 'review-attempt' && record.payload.purpose === 'correction',
    ),
  ).toHaveLength(0)
  expect(
    raced.after.records.filter(
      (record) => record?.kind === 'contribution' && record.payload.content === 'operator-request',
    ),
  ).toHaveLength(0)
  const oldRef: RecordInputRef = {
    source: 'record',
    record: {
      scope: { repository: old.repository, target: old.target },
      kind: 'action-receipt',
      recordId: old.recordId,
    },
    selector: '/payload',
    digest: canonicalValueDigest(old.payload),
  }
  const beforePrepare = pullHistory(box)
  const issueComments = readSim(box).issues['42']?.comments
  const checkpoint = reconstructFixCheckpoint(beforePrepare)
  const recordsBefore = beforePrepare.operations.flatMap((item) => (item.record ? [item.record] : []))
  expect(recordsBefore.filter((record) => record.kind === 'fix-request')).toHaveLength(0)
  expect(
    recordsBefore.filter((record) => record.kind === 'review-attempt' && record.payload.purpose === 'correction'),
  ).toHaveLength(0)
  expect(
    recordsBefore.filter((record) => record.kind === 'contribution' && record.payload.content === 'operator-request'),
  ).toHaveLength(0)
  const preparePath = path.resolve(import.meta.dirname, '../../testing/ci-attribution-provenance-prepare-runner.ts')
  const stale = spawnSync(
    BUN,
    [preparePath, cwd, JSON.stringify({ code: firstOutput.attribution.manifest.code, ref: oldRef })],
    {
      cwd,
      env: box.env,
      encoding: 'utf8',
      timeout: 55_000,
    },
  )
  expect(stale.status, `${stale.stderr}\n${stale.stdout}`).toBe(0)
  const refusal = JSON.parse(stale.stdout) as { ok: boolean; diagnostics?: Array<{ code: string }> }
  expect(refusal.ok).toBe(false)
  expect(
    refusal.diagnostics?.map((item) => item.code),
    JSON.stringify(refusal),
  ).toEqual(['self-output'])
  const afterPrepare = pullHistory(box)
  expect(reconstructFixCheckpoint(afterPrepare)).toEqual(checkpoint)
  expect(afterPrepare.operations.map((item) => item.record)).toEqual(
    beforePrepare.operations.map((item) => item.record),
  )
  expect(readSim(box).issues['42']?.comments).toEqual(issueComments)
  writeFileSync(control, '{}')
  const fresh = spawnSync(BUN, [prefixPath, cwd, 'capture-intake'], {
    cwd,
    env: box.env,
    encoding: 'utf8',
    timeout: 55_000,
  })
  expect(fresh.status, `${fresh.stderr}\n${fresh.stdout}`).toBe(0)
  expect(fresh.stdout).not.toContain('fix-open-request-ambiguous')
  const freshOutput = JSON.parse(fresh.stdout) as { attribution: ActionInputs; intake: ActionInputs }
  const latest = pullHistory(box)
  const freshReceipt = latest.operations.find(
    (operation) =>
      operation.record?.kind === 'action-receipt' &&
      operation.record.payload.action === 'attribute-ci' &&
      operation.record.payload.phase === 'result' &&
      operation.record.recordId !== old.recordId,
  )?.record
  if (
    freshReceipt?.kind !== 'action-receipt' ||
    freshReceipt.payload.action !== 'attribute-ci' ||
    freshReceipt.payload.phase !== 'result'
  )
    throw new Error('successor-attribution-missing')
  expect(freshReceipt.payload.mandate.recordId).not.toBe(old.payload.mandate.recordId)
  const oldSubject = old.payload.inputs.manifest.subject
  const freshSubject = freshReceipt.payload.inputs.manifest.subject
  if (oldSubject.kind !== 'uw' || !oldSubject.binding || freshSubject.kind !== 'uw' || !freshSubject.binding)
    throw new Error('successor-binding-missing')
  expect(freshSubject.binding).not.toEqual(oldSubject.binding)
  const successorBinding = latest.operations.find(
    (operation) =>
      operation.record?.kind === 'workflow-binding' &&
      operation.record.recordId === freshSubject.binding?.record.recordId,
  )?.record
  if (successorBinding?.kind !== 'workflow-binding') throw new Error('successor-binding-record-missing')
  expect(successorBinding.payload.mandate).toEqual(freshReceipt.payload.mandate)
  const fixRequest = latest.operations.find((operation) => operation.record?.kind === 'fix-request')?.record
  if (fixRequest?.kind !== 'fix-request') throw new Error('successor-fix-request-missing')
  const root = latest.operations.find(
    (operation) => operation.recordId === fixRequest.payload.requestContributionId,
  )?.record
  if (root?.kind !== 'contribution') throw new Error('successor-fix-root-missing')
  expect(root.payload.rawAttempts[0]?.raw).toMatchObject({
    operatorRequest: { ciCorrection: { attributionRecordId: freshReceipt.recordId } },
  })
  expect(freshOutput.attribution.manifest.plugin.commit).toBe(pin.candidate)
  expect(freshReceipt.payload.inputs.manifest.plugin.commit).toBe(pin.candidate)
  expect(freshOutput.intake.manifest.plugin.commit).toBe(pin.candidate)
  expect(freshOutput.intake.stageSources.map((ref) => ref.record.recordId)).toEqual([freshReceipt.recordId])
  expect(freshOutput.intake.stageSources[0]?.digest).toBe(canonicalValueDigest(freshReceipt.payload))
})
