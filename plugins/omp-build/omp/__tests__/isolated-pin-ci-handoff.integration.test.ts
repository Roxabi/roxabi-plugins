import { execFileSync, spawnSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { appendApprovedReview, PULL_SCOPE, pullHistory, setFailedCi } from '../../testing/feature-ci-review-fixture.ts'
import {
  arrangeReviewFixture,
  REVIEW_BRANCH as BRANCH,
  seedReviewFixture,
} from '../../testing/feature-review-fixture.ts'
import { isolatedPinSandbox } from '../../testing/isolated-pin-sandbox.ts'
import { readSim, writeSim } from '../../testing/sandbox/sandbox-repository.ts'

const BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const roots = new Set<string>()
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.clear()
})

it('uses the operator-activated pin for native approved-review freshness and CI attribution', async () => {
  const { box, cwd } = arrangeReviewFixture()
  roots.add(box.root)
  const pin = isolatedPinSandbox(box)
  const control = path.join(box.root, 'pin-control.json')
  writeFileSync(control, JSON.stringify({ shared: pin.candidate }))
  box.env = { ...pin.env, PIN_CONTROL_FILE: control }
  // Seed a genuine approved review against the candidate while that candidate is the ordinary pin.
  await seedReviewFixture(box, cwd)
  appendApprovedReview(box, cwd)
  setFailedCi(box)
  expect(
    pullHistory(box).operations.some(
      (operation) => operation.record?.kind === 'action-receipt' && operation.record.payload.action === 'attribute-ci',
    ),
  ).toBe(false)
  // A fresh process now sees the older shared pin and must obtain the operator's activation.
  writeFileSync(control, '{}')
  const run = spawnSync(
    BUN,
    [path.resolve(import.meta.dirname, '../../testing/isolated-pin-scenarios-runner.ts'), cwd, 'native-ci', cwd, cwd],
    { cwd, env: box.env, encoding: 'utf8', timeout: 45_000 },
  )
  expect(run.status, `${run.stderr}\n${run.stdout}`).toBe(0)
  const observed = JSON.parse(run.stdout) as { displayed: string[]; notices: string[] }
  expect(observed.displayed.join('\n')).toContain(pin.candidate)
  expect(observed.notices.join('\n')).toContain('OMP_BUILD_NATIVE_BATCH')
  const start = pullHistory(box).operations.find(
    (operation) =>
      operation.record?.kind === 'action-receipt' &&
      operation.record.payload.phase === 'start' &&
      operation.record.payload.action === 'attribute-ci',
  )?.record
  expect(start).toMatchObject({
    kind: 'action-receipt',
    payload: {
      phase: 'start',
      action: 'attribute-ci',
      exactInputs: { candidateGitSHA: box.sha[BRANCH], scope: PULL_SCOPE, failedChecks: ['ci'] },
    },
  })
})

it.each(['native-watch-timeout', 'native-watch-success'] as const)(
  'retains the activated pin through the real watch exit: %s',
  async (scenario) => {
    const { box, cwd } = arrangeReviewFixture()
    roots.add(box.root)
    const pin = isolatedPinSandbox(box)
    const control = path.join(box.root, 'pin-control.json')
    writeFileSync(control, JSON.stringify({ shared: pin.candidate, requiredChecks: ['ci'] }))
    box.env = { ...pin.env, PIN_CONTROL_FILE: control }
    await seedReviewFixture(box, cwd)
    appendApprovedReview(box, cwd)
    setFailedCi(box)
    const head = box.sha[BRANCH]
    if (head === undefined) throw new Error('watch-fixture-head-missing')
    writeSim(box, (state) => {
      for (const check of state.checks[head])
        Object.assign(check, {
          status: 'in_progress',
          conclusion: '',
          state: 'PENDING',
        })
    })
    writeFileSync(control, JSON.stringify({ requiredChecks: ['ci'] }))
    const run = spawnSync(
      BUN,
      [path.resolve(import.meta.dirname, '../../testing/isolated-pin-scenarios-runner.ts'), cwd, scenario, cwd, cwd],
      { cwd, env: box.env, encoding: 'utf8', timeout: 45_000 },
    )
    expect(run.status, `${run.stderr}\n${run.stdout}`).toBe(0)
    const observed = JSON.parse(run.stdout) as { displayed: string[]; notices: string[] }
    expect(observed.displayed.join('\n')).toContain(pin.candidate)
    const pull = readSim(box).prs['7']
    if (scenario === 'native-watch-timeout') {
      expect(observed.notices.join('\n')).toContain('feature-held: timeout')
      expect(pull.state).toBe('OPEN')
      expect(pull.autoMerge).not.toBeNull()
    } else {
      expect(pull.state).toBe('MERGED')
      expect(pull.mergeCommit).not.toBeNull()
    }
  },
)
