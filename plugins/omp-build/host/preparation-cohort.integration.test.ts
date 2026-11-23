import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { gh as trackedGh } from '../adapters/github/types.ts'
import { readGitHubHistory } from '../dist/contracts.js'
import { disarmGate, readGate } from '../skills/feature/workflow-gate.js'
import { arrangeReviewFixture } from '../testing/feature-review-fixture.ts'
import { readSim, writeSim } from '../testing/sandbox/sandbox-repository.ts'
import { createPreparationCohort, trackPreparationOperation, withPreparationAttribution } from './preparation-cohort.ts'

const BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const runner = path.resolve(import.meta.dirname, '../testing/preparation-host-runner.ts')
const worker = path.resolve(import.meta.dirname, '../testing/preparation-host-worker.ts')
const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

it.each(['join', 'stream-failure'] as const)('joins real host work and streams before resolving: %s', (mode) => {
  const root = mkdtempSync(path.join(tmpdir(), 'preparation-host-'))
  try {
    writeFileSync(path.join(root, 'gh'), `#!/bin/sh\nexec ${shellQuote(BUN)} ${shellQuote(worker)}\n`, { mode: 0o700 })
    const env = {
      ...process.env,
      PATH: `${root}:${process.env.PATH}`,
      PREPARATION_TEST_FIFO: path.join(root, 'release.fifo'),
    }
    const run = spawnSync(BUN, [runner, root, mode], { cwd: root, env, encoding: 'utf8', timeout: 45_000 })
    expect(run.status, `${run.error?.message ?? ''}\n${run.stderr}\n${run.stdout}`).toBe(0)
    expect(JSON.parse(run.stdout)).toEqual({ mode, completed: true })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('retains exact publication attribution on actual GitHub transport appends', async () => {
  const { box, cwd } = arrangeReviewFixture()
  try {
    const execute = promisify(execFile)
    const gh = trackedGh({
      cwd,
      gh: async (directory, args) =>
        (await execute('gh', args, { cwd: directory, env: box.env, encoding: 'utf8' })).stdout.trim(),
    })
    const cohort = createPreparationCohort()
    const reservation = { publication: 'source' }
    await cohort.run(() =>
      withPreparationAttribution(reservation, async () => {
        const equalToken = { ...reservation }
        await Promise.resolve()
        await gh(cwd, [
          'api',
          '--method',
          'POST',
          'repos/acme/app/issues/42/comments',
          '-f',
          'body=reserved fixture append',
        ])
        await withPreparationAttribution(equalToken, async () => {
          await Promise.resolve()
          await gh(cwd, [
            'api',
            '--method',
            'POST',
            'repos/acme/app/issues/42/comments',
            '-f',
            'body=other fixture append',
          ])
        })
      }),
    )
    cohort.seal()
    const joined = await cohort.join()
    if (joined.status !== 'joined') throw new Error(`fixture-cohort-not-joined:${JSON.stringify(joined)}`)
    const appends = joined.operations.filter((item) => item.kind === 'gh-append')
    expect(appends).toHaveLength(2)
    expect(appends[0]?.attribution).toBe(reservation)
    expect(appends[1]?.attribution).toEqual(reservation)
    expect(appends[1]?.attribution).not.toBe(reservation)
    expect(readSim(box).issues['42']?.comments.map((comment) => comment.body)).toEqual([
      'reserved fixture append',
      'other fixture append',
    ])
  } finally {
    rmSync(box.root, { recursive: true, force: true })
  }
})

it('joins bundled transport under the exact real disarm attribution without merging concurrent cohorts', async () => {
  const { box, cwd } = arrangeReviewFixture()
  const marker = path.join(box.root, 'bundled-read-started')
  const release = path.join(box.root, 'bundled-read-release')
  const execute = promisify(execFile)
  const sourceGh = trackedGh({
    cwd,
    gh: async (directory, args) =>
      (await execute('gh', args, { cwd: directory, env: box.env, encoding: 'utf8' })).stdout.trim(),
  })
  let pending: ReturnType<typeof readGitHubHistory> | undefined
  try {
    writeSim(box, (state) => {
      const pr = state.prs['7']
      if (!pr) throw new Error('fixture-pr-missing')
      pr.labels = ['reviewed']
      pr.autoMerge = { enabledAt: '2026-01-01T00:00:00Z' }
    })
    const gate = await readGate(cwd, 7, sourceGh)
    const cohort = createPreparationCohort()
    const disarm = cohort.run(() =>
      disarmGate(cwd, 7, gate, async (directory: string, args: string[]) => {
        if (pending === undefined) {
          // The bundled transport owns this actual process and its pipes; it remains in flight
          // while the real source workflow disarm and authorization readback complete.
          pending = readGitHubHistory(
            { repository: 'acme/app', target: 'acme/app#42' },
            {
              cwd,
              readAuthor: 'operator',
              gh: async (childCwd, childArgs) => {
                const script = `printf ready > ${shellQuote(marker)}; while [ ! -f ${shellQuote(release)} ]; do sleep 0.05; done; exec "$@"`
                await trackPreparationOperation('git', async () =>
                  (
                    await execute('git', ['rev-parse', 'HEAD'], { cwd: childCwd, env: box.env, encoding: 'utf8' })
                  ).stdout.trim(),
                )
                return (
                  await execute('sh', ['-c', script, 'bundled-gh', 'gh', ...childArgs], {
                    cwd: childCwd,
                    env: box.env,
                    encoding: 'utf8',
                  })
                ).stdout.trim()
              },
            },
          )
        }
        return sourceGh(directory, args)
      }),
    )
    const deadline = Date.now() + 30_000
    // The marker is written by the real subprocess; fake timers cannot drive its startup.
    while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
    expect(existsSync(marker)).toBe(true)
    await disarm
    expect(pending).toBeDefined()
    if (pending === undefined) throw new Error('fixture-history-not-started')
    const second = createPreparationCohort()
    await second.run(() => trackPreparationOperation('git', async () => 'other-root'))
    second.seal()
    const other = await second.join()
    expect(other).toMatchObject({ status: 'joined', operations: [{ kind: 'git', outcome: 'fulfilled' }] })

    cohort.seal()
    let joinedEarly = false
    const joined = cohort.join().then((value) => {
      joinedEarly = true
      return value
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(joinedEarly).toBe(false)
    writeFileSync(release, 'release\n')
    const history = await pending
    expect(history.complete).toBe(true)
    const host = await joined
    if (host.status !== 'joined') throw new Error(`fixture-cohort-not-joined:${JSON.stringify(host)}`)
    const nestedGit = host.operations.filter((operation) => operation.kind === 'git')
    expect(nestedGit).toHaveLength(1)
    expect(host.disarmConfirmations).toHaveLength(1)
    const receipt = host.disarmConfirmations[0]
    if (receipt === undefined) throw new Error('fixture-disarm-receipt-missing')
    expect(receipt).toMatchObject({
      repository: 'acme/app',
      pr: 7,
      head: box.sha['feat/42-save'],
      authorizationReceiptId: expect.any(Number),
    })
    expect(nestedGit[0]?.attribution).toBe(receipt.attribution)
    const writes = host.operations.filter(
      (operation) => operation.kind === 'gh-write' || operation.kind === 'gh-append',
    )
    expect(writes.length).toBeGreaterThan(0)
    for (const operation of writes) expect(operation.attribution).toBe(receipt.attribution)
    expect(
      host.operations.some(
        (operation) => operation.kind === 'gh-read' && operation.attribution === receipt.attribution,
      ),
    ).toBe(true)
    const pr = readSim(box).prs['7']
    expect(pr?.autoMerge).toBeNull()
    expect(pr?.labels).not.toContain('reviewed')
    expect(pr?.comments.length).toBeGreaterThan(0)
  } finally {
    writeFileSync(release, 'release\n')
    if (pending) await pending.catch(() => undefined)
    rmSync(box.root, { recursive: true, force: true })
  }
}, 90_000)

it('rejects an incompatible process context before source or bundle work without replacing the slot', () => {
  const source = pathToFileURL(path.resolve(import.meta.dirname, 'preparation-cohort.ts')).href
  const bundle = pathToFileURL(path.resolve(import.meta.dirname, '../dist/contracts.js')).href
  const script = `
    const key = Symbol.for('roxabi.omp-build.preparation-cohort.context')
    const sentinel = Object.freeze({ protocol: 999 })
    Object.defineProperty(globalThis, key, { value: sentinel, writable: false, configurable: false })
    for (const uri of ${JSON.stringify([source, bundle])}) {
      let refused = false
      try { await import(uri) } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('incompatible-preparation-cohort-context-protocol')) throw error
        refused = true
      }
      if (!refused || globalThis[key] !== sentinel) throw new Error('incompatible-slot-not-refused')
    }
    console.log('both-refused')
  `
  const child = spawnSync(BUN, ['-e', script], { encoding: 'utf8', timeout: 30_000 })
  expect(child.status, `${child.stderr}\n${child.stdout}`).toBe(0)
  expect(child.stdout.trim()).toBe('both-refused')
})
