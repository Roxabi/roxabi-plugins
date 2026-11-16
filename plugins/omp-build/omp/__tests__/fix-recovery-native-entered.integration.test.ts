import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, expect, it } from 'vitest'
import { featureMandate, pullHistory } from '../../testing/feature-ci-review-fixture.ts'
import { arrangeReviewFixture } from '../../testing/feature-review-fixture.ts'
import { readSim } from '../../testing/sandbox/sandbox-repository.ts'

const bun = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const worker = resolve(import.meta.dirname, '../../testing/fix-recovery-ci-worker.ts')
const seedWorker = resolve(import.meta.dirname, '../../testing/fix-recovery-cold-worker.ts')
const leaseWorker = resolve(import.meta.dirname, '../../testing/linux-execution-lease-process.ts')
const fault = resolve(import.meta.dirname, '../../testing/fix-recovery-gh-fault.ts')
const roots = new Set<string>()
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.clear()
})

it('retains the originating obligations after an entered native child exits without a settlement witness', async () => {
  const { box, cwd } = arrangeReviewFixture()
  roots.add(box.root)
  const wrapper = join(box.root, 'bin', 'gh')
  unlinkSync(wrapper)
  symlinkSync(fault, wrapper)
  const ghConfig = join(box.root, 'gh-config')
  mkdirSync(ghConfig)
  const env: NodeJS.ProcessEnv = {
    ...box.env,
    HOME: box.root,
    GH_CONFIG_DIR: ghConfig,
    GH_SIM_STATE: box.stateFile,
    RECOVERY_TEST_CREDENTIAL: 'fixture-model-only',
  }
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST'])
    delete env[key]
  const input = JSON.stringify({ ...box, env: {} })
  const seed = spawnSync(bun, [seedWorker, 'seed', cwd, box.root, box.stateFile, input], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 120_000,
  })
  expect(seed.status, `${seed.stderr}\n${seed.stdout}`).toBe(0)

  const ready = join(box.root, 'active-child-ready')
  const release = join(box.root, 'release-active-child')
  const origin = spawn(bun, [worker, 'origin', cwd, box.root, box.stateFile, input], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 240_000,
  })
  let stdout = '',
    stderr = ''
  origin.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk
  })
  origin.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk
  })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
    origin.once('error', reject)
    origin.once('close', (code, signal) => resolveExit({ code, signal }))
  })
  try {
    const end = Date.now() + 90_000
    while (!existsSync(ready) && origin.exitCode === null && Date.now() < end) await delay(25)
    expect(existsSync(ready), `origin did not enter native intake: ${stderr}\n${stdout}`).toBe(true)
    const entered = JSON.parse(readFileSync(ready, 'utf8'))
    expect(entered).toMatchObject({ called: true, leaseHeld: true })
    expect(entered.nativeDispatches).toContain('held-native')
    expect(entered.children.length).toBeGreaterThan(0)
    expect(readFileSync(join(box.root, 'active-child-probe'), 'utf8')).toContain('save')
  } finally {
    writeFileSync(release, 'release\n')
    const result = await exited
    expect(result, `${stderr}\n${stdout}`).toEqual({ code: 0, signal: null })
  }
  expect(`${stderr}\n${stdout}`).toContain('fix-owner-no-entry-unavailable')
  const opening = featureMandate(box).history.operations.find(
    (item) => item.status === 'complete' && item.record?.kind === 'fix-owner' && item.record.payload.phase === 'opened',
  )?.record
  if (opening?.kind !== 'fix-owner' || opening.payload.phase !== 'opened') throw new Error('origin-opening-missing')
  expect(
    featureMandate(box).history.operations.some(
      (item) =>
        item.status === 'complete' && item.record?.kind === 'fix-owner' && item.record.payload.phase === 'settled',
    ),
  ).toBe(false)
  expect(
    pullHistory(box).operations.some((item) => item.status === 'complete' && item.record?.kind === 'fix-request'),
  ).toBe(true)

  // The native mutex is free, but that fact does not resolve the durable owner.
  const lease = spawnSync(bun, [leaseWorker, JSON.stringify(opening.payload.common.destination)], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 30_000,
    input: '{"command":"acquire"}\n{"command":"release"}\n{"command":"exit"}\n',
  })
  expect(lease.status, `${lease.stderr}\n${lease.stdout}`).toBe(0)
  const leaseResults = lease.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(leaseResults[0]).toMatchObject({ status: 'acquired' })
  expect(leaseResults[1]).toEqual({ status: 'released' })

  const before = readSim(box)
  const recovery = spawnSync(bun, [worker, 'recover', cwd, box.root, box.stateFile, input], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 90_000,
  })
  expect(recovery.status, `${recovery.stderr}\n${recovery.stdout}`).toBe(0)
  const line = recovery.stdout
    .trim()
    .split('\n')
    .findLast((item) => item.startsWith('{"mode"'))
  expect(line, `${recovery.stderr}\n${recovery.stdout}`).toBeDefined()
  if (line === undefined) throw new Error('fixture-recovery-output-missing')
  const refused = JSON.parse(line)
  expect(refused.called).toBe(true)
  expect(refused.approvals).toBe(0)
  expect(refused.confirmationCount).toBe(0)
  expect(refused.nativeDispatches).toEqual([])
  expect(refused.children).toEqual([])
  expect(JSON.stringify(refused.messages)).toContain('fix-owner-admission-refused')
  expect(JSON.stringify(refused.messages)).toContain('An active or requestless owner still holds the destination')
  const after = readSim(box)
  expect(after.issues).toEqual(before.issues)
  expect(after.prs).toEqual(before.prs)
  expect(after.nextCommentId).toEqual(before.nextCommentId)
}, 360_000)
