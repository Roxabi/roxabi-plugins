import { execFileSync, spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { readSim } from '../../skills/feature/__fixtures__/proof/sandbox-repository.ts'
import type { Box } from '../../skills/feature/__fixtures__/proof/sandbox-types.ts'
import { arrangeReviewFixture, seedReviewFixture } from '../../testing/feature-review-fixture.ts'

const RUNNER = path.resolve(import.meta.dirname, '../../testing/feature-recovery-runner.ts')
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

function invoke(box: Box, cwd: string, operation: string) {
  const run = spawnSync(BUN, [RUNNER, operation, cwd, '{}'], {
    cwd,
    env: box.env,
    encoding: 'utf8',
    timeout: 30_000,
    killSignal: 'SIGKILL',
  })
  if (run.status !== 0) throw new Error(`${operation} failed: ${run.stderr}\n${run.stdout}`)
  return JSON.parse(run.stdout) as {
    active: unknown
    fixRun?: unknown
    messages: string[]
    precondition: { complete: true; requests: number; action?: string }
    pause?: { postRefused: boolean; operatorControls: number; ghAvailable: boolean }
    summary?: { complete: boolean; reviews: number; action: string; reason: string }
    records: Array<{ kind: string; recordId: string }>
  }
}

describe('review continuation races', () => {
  it('does not activate a correction after a complete third canonical request-changes review', async () => {
    const { box, cwd } = arrange()
    await seed(box, cwd)
    const observed = invoke(box, cwd, 'omp-review-race-latest')
    expect(observed.precondition).toEqual({ complete: true, requests: 1 })
    expect(observed.summary).toEqual({ complete: true, reviews: 3, action: 'stop', reason: 'review-bound' })
    expect(observed.active).toBeNull()
    expect(observed.records.filter((record) => record.kind === 'fix-request')).toHaveLength(1)
    expect(observed.messages.filter((message) => message.includes('OMP_BUILD_NATIVE_BATCH'))).toHaveLength(2)
  })

  it('does not start a correction after local pause inhibits a checkout-blocked continuation', async () => {
    const { box, cwd } = arrange()
    await seed(box, cwd)
    const observed = invoke(box, cwd, 'omp-review-race-pause')
    expect(observed.precondition).toEqual({ complete: true, action: 'fix', requests: 0 })
    expect(observed.pause).toEqual({ postRefused: true, operatorControls: 0, ghAvailable: true })
    expect(observed.active).toBeNull()
    expect(observed.fixRun).toBeUndefined()
    expect(observed.records.some((record) => record.kind === 'fix-request')).toBe(false)
    expect(observed.messages.filter((message) => message.includes('OMP_BUILD_NATIVE_BATCH'))).toHaveLength(2)
    const comments = readSim(box).issues['42']?.comments ?? []
    expect(comments.some((comment) => comment.body.includes('operator-control'))).toBe(false)
  })
})
