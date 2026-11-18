import { execFileSync, spawnSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { featureMandate, pullHistory } from '../testing/feature-ci-review-fixture.ts'
import { arrangeReviewFixture, seedReviewFixture } from '../testing/feature-review-fixture.ts'
import { isolatedPinSandbox } from '../testing/isolated-pin-sandbox.ts'
import { readSim } from '../testing/sandbox/sandbox-repository.ts'
import { currentAccountedMandate } from './uw-action-selection.ts'

const BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const roots = new Set<string>()
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.clear()
})

it('refuses interrupted succession at entry without treating stale predecessor binding as current', async () => {
  const { box, cwd } = arrangeReviewFixture()
  roots.add(box.root)
  const pin = isolatedPinSandbox(box)
  const control = path.join(box.root, 'pin-control.json')
  writeFileSync(control, JSON.stringify({ shared: pin.candidate }))
  box.env = { ...pin.env, PIN_CONTROL_FILE: control }
  await seedReviewFixture(box, cwd)
  const runner = path.resolve(import.meta.dirname, '../testing/ci-alias-current-mandate-runner.ts')
  const execute = (file: string, ...args: string[]) => {
    const run = spawnSync(BUN, [file, cwd, ...args], { cwd, env: box.env, encoding: 'utf8', timeout: 55_000 })
    expect(run.status, `${run.stderr}\n${run.stdout}`).toBe(0)
    return JSON.parse(run.stdout)
  }
  const initial = execute(runner, 'resolve')
  expect(initial.ok).toBe(true)
  expect(initial.value).toMatchObject({ kind: 'pull-request', number: 7 })
  const predecessor = featureMandate(box).record
  expect(execute(runner, 'interrupt')).toMatchObject({ refused: true, result: { ok: false } })
  const issue = featureMandate(box).history
  // Interrupted succession publishes a successor mandate without select-successor — not current-accounted.
  const published = issue.operations
    .map((operation) => operation.record)
    .filter(
      (record): record is NonNullable<typeof record> & { kind: 'mandate' } =>
        record?.kind === 'mandate' && record.recordId !== predecessor.recordId,
    )
  expect(published.length).toBeGreaterThan(0)
  const successor = published[published.length - 1]
  if (successor === undefined) throw new Error('successor-mandate-missing')
  expect(successor.payload.branch).toBe(predecessor.payload.branch)
  expect(successor.payload.base).toBe(predecessor.payload.base)
  expect({ repository: successor.repository, target: successor.target }).toEqual({
    repository: predecessor.repository,
    target: predecessor.target,
  })
  const current = currentAccountedMandate(issue)
  expect(current.ok).toBe(false)
  const bindings = pullHistory(box).operations.flatMap((operation) =>
    operation.record?.kind === 'workflow-binding' ? [operation.record] : [],
  )
  expect(bindings).toHaveLength(1)
  expect(bindings[0]?.payload.mandate.recordId).toBe(predecessor.recordId)
  const observed = execute(runner, 'inspect')
  expect(observed.current).toMatchObject({ ok: false })
  expect(observed.binding).toMatchObject({
    mandateScope: { repository: predecessor.repository, target: predecessor.target },
    mandateRecordId: predecessor.recordId,
  })
  const before = readSim(box)
  const result = execute(runner, JSON.stringify(initial.value))
  // Interrupted successor has no current accounted mandate — distinct from binding-mismatch
  // (which requires a current mandate whose binding names a different record).
  expect(result.reread).toEqual({ ok: false, diagnostics: ['fix-issue-alias-no-mandate'] })
  expect(result.entry).toEqual({ ok: false, diagnostics: ['fix-issue-alias-no-mandate'] })
  const after = readSim(box)
  expect(after.issues['42']?.comments).toEqual(before.issues['42']?.comments)
  expect(after.prs['7']?.comments).toEqual(before.prs['7']?.comments)
})
