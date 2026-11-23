import { execFileSync, spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { arrangeReviewFixture, seedReviewFixture } from '../../testing/feature-review-fixture.ts'
import type { Box } from '../../testing/sandbox/sandbox-types.ts'

const RUNNER = path.resolve(import.meta.dirname, 'native-review-integration-runner.ts')
const BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const roots = new Set<string>()

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.clear()
})

function arrange() {
  const fixture = arrangeReviewFixture()
  roots.add(fixture.box.root)
  return fixture
}

async function seed(...args: Parameters<typeof seedReviewFixture>): Promise<void> {
  await seedReviewFixture(...args)
}

function invoke(box: Box, cwd: string, operation: string, timeout = 30_000) {
  const run = spawnSync(BUN, [RUNNER, operation, cwd], {
    cwd,
    env: box.env,
    encoding: 'utf8',
    timeout,
    killSignal: 'SIGKILL',
  })
  if (run.status !== 0) throw new Error(`${operation} failed: ${run.stderr}\n${run.stdout}`)
  return JSON.parse(run.stdout) as {
    active: unknown
    ownerReleasedBeforePost?: boolean
    driverPendingBeforeRelease?: boolean
    refusal?: string
    ingressHeld?: boolean
    hold?: string
    seeded?: { precondition: { complete: boolean; action: string; requests: number } }
    before?: Array<{ kind: string; recordId: string }>
    after?: Array<{ kind: string; recordId: string }>
    issueBefore?: Array<{ kind: string; recordId: string }>
    issueAfter?: Array<{ kind: string; recordId: string }>
    messages: string[]
    precondition: { complete: true; requests: number; action?: string }
    summary?: { complete: boolean; reviews: number; action: string; reason: string }
    records: Array<{ kind: string; recordId: string; payload: { control?: string } }>
    issueRecords: Array<{ kind: string; recordId: string; payload: { control?: string } }>
  }
}

describe('review continuation races', () => {
  it('refuses another native review after three canonical request-changes reviews', async () => {
    const { box, cwd } = arrange()
    await seed(box, cwd)
    const observed = invoke(box, cwd, 'latest', 60_000)
    expect(observed.refusal).toBe('review-not-authorized:stop')
    expect(observed.summary).toEqual({ complete: true, reviews: 3, action: 'stop', reason: 'review-bound' })
    expect(observed.active).toBeNull()
    expect(observed.records.filter((record) => record.kind === 'fix-request')).toHaveLength(0)
    expect(observed.messages.filter((message) => message.includes('OMP_BUILD_NATIVE_BATCH'))).toHaveLength(2)
  }, 120_000)

  it('joins a real owned Fix preflight before publishing a durable pause', async () => {
    const { box, cwd } = arrange()
    await seed(box, cwd)
    const observed = invoke(box, cwd, 'owned-pause', 60_000)
    expect(observed.precondition).toEqual({ complete: true, requests: 0 })
    expect(observed.driverPendingBeforeRelease).toBe(true)
    expect(observed.ownerReleasedBeforePost).toBe(true)
    expect(
      observed.issueRecords.some(
        (record) => record.kind === 'operator-control' && record.payload.control === 'pause-confirmed',
      ),
    ).toBe(true)
    expect(observed.records.filter((record) => record.kind === 'fix-request')).toHaveLength(0)
    expect(observed.records.some((record) => record.kind === 'fix-result')).toBe(false)
    expect(observed.messages.filter((message) => message.includes('OMP_BUILD_NATIVE_BATCH'))).toHaveLength(2)
  }, 120_000)

  it('does not claim a durable pause while real pre-owner Fix ingress is unjoinable', async () => {
    const { box, cwd } = arrange()
    await seed(box, cwd)
    const observed = invoke(box, cwd, 'classified-ingress', 90_000)
    expect(observed.seeded?.precondition).toEqual({ complete: true, action: 'fix', requests: 0 })
    expect(observed.hold).toContain('feature-fix-ingress-unjoined')
    expect(observed.ingressHeld).toBe(true)
    expect(observed.before?.some((record) => record.kind === 'fix-request')).toBe(false)
    const correction = (records: Array<{ kind: string; recordId: string }> | undefined) =>
      records?.filter((record) =>
        ['fix-request', 'contribution', 'correction-result', 'fix-result', 'operator-control'].includes(record.kind),
      )
    expect(correction(observed.after)).toEqual(correction(observed.before))
    const controlsBefore = observed.issueBefore?.filter((record) => record.kind === 'operator-control')
    const controlsAfter = observed.issueAfter?.filter((record) => record.kind === 'operator-control')
    expect(controlsBefore).toEqual([])
    expect(controlsAfter).toEqual(controlsBefore)
    expect(observed.messages.filter((message) => message.includes('OMP_BUILD_NATIVE_BATCH'))).toHaveLength(0)
  }, 120_000)
})
