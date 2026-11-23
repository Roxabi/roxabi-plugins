import { execFile } from 'node:child_process'
import { rmSync } from 'node:fs'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { nextReviewStep } from '../skills/feature/workflow-review-state.js'
import { arrangeReviewFixture } from '../testing/feature-review-fixture.ts'
import type { NativePort } from './fix-contract.ts'
import { startDefaultFix } from './fix-entry-lifecycle.ts'
import type { Gh } from './fix-entry-target-core.ts'
import { createInstalledUwOperations } from './uw-installed-operations.ts'
import { createInstalledUwReadPort } from './uw-read-port.ts'

const execFileAsync = promisify(execFile)
const roots = new Set<string>()
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.clear()
})

it('waits for the pre-admission standalone driver to drain before stop finishes', async () => {
  const { box, cwd } = arrangeReviewFixture()
  roots.add(box.root)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<string>()
  const gh: Gh = async (directory, args) => {
    // Target resolution has already read the real local origin/main before this
    // external repository-default request. Hold only this transport response.
    if (args[0] === 'repo' && args[1] === 'view' && args[2] === 'acme/app') {
      entered.resolve()
      return release.promise
    }
    const result = await execFileAsync('gh', args, { cwd: directory, env: box.env, encoding: 'utf8' })
    return result.stdout.trim()
  }
  const unexpected = (): never => {
    throw new Error('unexpected-native-or-operator-execution')
  }
  const native: NativePort = { activate: unexpected, active: unexpected, stopOwned: unexpected, announce: unexpected }
  const operations = await createInstalledUwOperations({
    cwd,
    gh,
    readAuthor: 'operator',
    operator: { executeConfirmed: async () => unexpected() },
  })
  const shared = {
    cwd,
    reference: '#7',
    gh,
    native,
    workflow: { nextReviewStep },
    operations,
    uw: createInstalledUwReadPort({ cwd, gh, readAuthor: 'operator' }),
  }
  const run = startDefaultFix({ ...shared, args: 'correct the issue' })
  const first = await Promise.race([
    entered.promise.then(() => ({ kind: 'entered' as const })),
    run.completion.then((result) => ({ kind: 'completion' as const, result })),
  ])
  expect(first).toEqual({ kind: 'entered' })
  const stopping = run.stop('test-stop')
  const stoppingAgain = run.stop('duplicate-stop')
  let settledStops = 0
  for (const pending of [stopping, stoppingAgain]) {
    void pending.then(
      () => {
        settledStops += 1
      },
      () => {
        settledStops += 1
      },
    )
  }
  try {
    expect(await run.completion).toEqual({
      ok: false,
      diagnostics: ['fix-run-interrupted-cleanup-unproven:test-stop'],
    })
    // One event-loop turn lets an already-settled stop propagate, without a timer or polling.
    const turn = Promise.withResolvers<void>()
    setImmediate(turn.resolve)
    await turn.promise
    expect(settledStops).toBe(0)
  } finally {
    release.reject(new Error('external repository read released'))
    await Promise.all([stopping, stoppingAgain])
  }
})
