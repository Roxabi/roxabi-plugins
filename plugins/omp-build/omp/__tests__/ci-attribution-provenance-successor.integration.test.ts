import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { canonicalValueDigest } from '../../engine/action-input.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import { reconstructFixCheckpoint } from '../../roxabi/fix-checkpoint-state.ts'
import type { RecordInputRef } from '../../roxabi/uw-action-contract.ts'
import { createSuccessorFixture } from '../../testing/ci-attribution-provenance-successor-fixture.ts'
import { pullHistory } from '../../testing/feature-ci-review-fixture.ts'
import { readSim } from '../../testing/sandbox/sandbox-repository.ts'

const BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const roots = new Set<string>()
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.clear()
})

it('refuses stale attribution before publishing a correction root', async () => {
  const { box, cwd, pin, control, firstOutput, old } = await createSuccessorFixture(roots)
  writeFileSync(control, JSON.stringify({ shared: pin.candidate }))
  const racePath = path.resolve(import.meta.dirname, '../../testing/ci-attribution-provenance-race-runner.ts')
  const bin = path.join(box.root, 'race-bin')
  const ghConfig = path.join(box.root, 'race-gh-config')
  mkdirSync(bin)
  mkdirSync(ghConfig)
  symlinkSync(
    process.env.OMP_TEST_GH_FAULT_CLIENT_PATH ??
      path.resolve(import.meta.dirname, '../../testing/fix-recovery-gh-fault.ts'),
    path.join(bin, 'gh'),
  )
  const env: NodeJS.ProcessEnv = { ...box.env, PATH: `${bin}:${box.env.PATH}`, HOME: box.root, GH_CONFIG_DIR: ghConfig }
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST'])
    delete env[key]
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
    { cwd, env, encoding: 'utf8', timeout: 55_000 },
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
})
