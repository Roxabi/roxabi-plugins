// Temporary diagnostic, removed before the corrective PR is qualified.
// This is not a replacement test: the existing 55s watchdog and assertions stay unchanged.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { availableParallelism, cpus, tmpdir } from 'node:os'
import path from 'node:path'
import type { TestProject } from 'vitest/node'
import type { ActionInputs } from '../plugins/omp-build/engine/action-input-schema.ts'
import { appendApprovedReview, setFailedCi } from '../plugins/omp-build/testing/feature-ci-review-fixture.ts'
import { arrangeReviewFixture, seedReviewFixture } from '../plugins/omp-build/testing/feature-review-fixture.ts'
import { isolatedPinSandbox } from '../plugins/omp-build/testing/isolated-pin-sandbox.ts'
import { readSim } from '../plugins/omp-build/testing/sandbox/sandbox-repository.ts'
import type { Box } from '../plugins/omp-build/testing/sandbox/sandbox-types.ts'
import setupSimulator from '../vitest.integration.global-setup.ts'

const repo = path.resolve(import.meta.dirname, '..')
const output = mkdtempSync(path.join(tmpdir(), 'omp-native-ci-probe-'))
const provided = new Map<string, string>()
const provide: TestProject['provide'] = (key, value) => {
  if (typeof value !== 'string') throw new Error(`Unexpected fixture compiler value: ${key}`)
  provided.set(key, value)
}
// The existing compiler setup only uses provide; this does not emulate a Vitest run.
const cleanupSimulator = setupSimulator({ provide } as TestProject)
process.env.OMP_TEST_GH_SIMULATOR_PATH = provided.get('ompTestGhSimulatorPath')
process.env.OMP_TEST_PIN_GH_PATH = provided.get('ompTestPinGhPath')
process.env.OMP_TEST_TOOLING_GH_PATH = provided.get('ompTestToolingGhPath')
process.env.GITHUB_REPO = 'Test/test-repo'
console.log('Diagnostic only: observing completion up to 90s; the required test still has its original 55s watchdog.')
let box: Box | undefined
try {
  const arranged = arrangeReviewFixture()
  box = arranged.box
  const cwd = arranged.cwd
  const pin = isolatedPinSandbox(box)
  const control = path.join(box.root, 'pin-control.json')
  writeFileSync(control, JSON.stringify({ shared: pin.candidate }))
  box.env = { ...pin.env, PIN_CONTROL_FILE: control }
  await seedReviewFixture(box, cwd)
  appendApprovedReview(box, cwd)
  setFailedCi(box)
  writeFileSync(control, '{}')
  const start = performance.now()
  const run = spawnSync(
    process.execPath,
    [`${repo}/plugins/omp-build/testing/ci-correction-lifecycle-runner.ts`, cwd],
    {
      cwd,
      env: box.env,
      encoding: 'utf8',
      timeout: 90_000,
    },
  )
  const elapsedMs = Math.round(performance.now() - start)
  const state = readSim(box)
  const commands = new Map<string, number>()
  for (const call of state.calls) {
    const command = call.slice(0, 2).join(' ')
    commands.set(command, (commands.get(command) ?? 0) + 1)
  }
  const metrics = {
    status: run.status,
    signal: run.signal,
    errorCode: (run.error as NodeJS.ErrnoException | undefined)?.code ?? null,
    elapsedMs,
    availableParallelism: availableParallelism(),
    cpuModel: cpus()[0]?.model ?? null,
    bunVersion: process.versions.bun,
    originalTestWatchdogMs: 55_000,
    finishedWithinOriginalWatchdog: run.status === 0 && elapsedMs < 55_000,
    stateBytes: statSync(box.stateFile).size,
    simulatorCalls: state.calls.length,
    fields: Object.fromEntries(
      Object.entries(state).map(([key, value]) => [key, Buffer.byteLength(JSON.stringify(value))]),
    ),
    commands: Object.fromEntries([...commands.entries()].sort((a, b) => b[1] - a[1])),
    phases: run.stderr.trim().split('\n'),
  }
  writeFileSync(path.join(output, 'metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`)
  writeFileSync(path.join(output, 'run-stdout.json'), run.stdout)
  copyFileSync(box.stateFile, path.join(output, 'gh-state.json'))
  console.log(JSON.stringify(metrics, null, 2))
  assert.equal(run.status, 0, run.stderr)
  const observed = JSON.parse(run.stdout) as {
    priorHead: string
    commit: string
    replay: { head: string; verdict: string }
    manifests: Array<{ stage: string; inputs: ActionInputs }>
  }
  assert.notEqual(observed.commit, observed.priorHead)
  assert.equal(state.prs['7']?.headRefOid, observed.commit)
  assert.equal(observed.replay.head, observed.commit)
  assert.equal(observed.replay.verdict, 'Approve (clean)')
  for (const stage of [
    'attribution',
    'intake',
    'synthesis',
    'apply',
    'post-apply',
    'follow-on-review',
    'follow-on-synthesis',
  ]) {
    const tasks = observed.manifests.filter((item) => item.stage === stage)
    assert.ok(tasks.length > 0, `missing stage: ${stage}`)
    for (const task of tasks) assert.equal(task.inputs.manifest.plugin.commit, pin.candidate, stage)
  }
  console.log(
    'Consumer checks PASS: changed head, published head, clean current-head review, all seven candidate-pinned stages.',
  )
} finally {
  if (box) rmSync(box.root, { recursive: true, force: true })
  cleanupSimulator()
}
