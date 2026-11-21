import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, type TestContext } from 'vitest'
import type { CanonicalRecord, DecodedHistory } from '../dist/contracts.js'
import { boundedLifecycleChild } from '../testing/bounded-lifecycle-child.ts'
import { arrangeReviewFixture, REVIEW_SCOPE, seedReviewFixture } from '../testing/feature-review-fixture.ts'
import type { Box } from '../testing/sandbox/sandbox-types.ts'

const runner = path.resolve(import.meta.dirname, '../testing/feature-recovery-runner.ts')
const bun = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()

type HistoryObservation = {
  source: Omit<DecodedHistory['source'], 'comments'>
  operations: Array<Omit<DecodedHistory['operations'][number], 'parts'>>
  diagnostics: DecodedHistory['diagnostics']
}

type Observation = {
  initialAccepted: string
  accepted: string
  originHistories: HistoryObservation[]
  before: HistoryObservation
  after: HistoryObservation
  diagnostics: unknown[]
  active: unknown
  fixRun: unknown
  settlementError: { message: string; errors: string[]; causeIsPrimary: boolean } | null
}

type BoundaryObservation = {
  baseline: { ok: boolean }
  result: { ok: boolean; diagnostics?: string[] }
  requested: Array<Array<{ repository: string; target: string }>>
  catalogueCalls: number
  dispositionPublishes: number
  correctionPublishes: number
  activations: number
  batches: number
  starts: number
  panels: CanonicalRecord[]
  after: DecodedHistory
}

async function boundary(
  task: TestContext['task'],
  box: Box,
  cwd: string,
  operation: 'omp-disposition-original-unavailable' | 'omp-disposition-foreign-synthesis',
): Promise<BoundaryObservation> {
  const child = await boundedLifecycleChild(task, bun, [runner, operation, cwd, '{}'], cwd, box.env)
  if (child.status !== 0) throw new Error(`Native correction boundary failed: ${child.stderr}\n${child.stdout}`)
  return JSON.parse(child.stdout) as BoundaryObservation
}

async function run(task: TestContext['task'], box: Box, cwd: string, broken: boolean): Promise<Observation> {
  const child = await boundedLifecycleChild(
    task,
    bun,
    [runner, broken ? 'omp-disposition-partition-broken' : 'omp-disposition-partition-valid', cwd, '{}'],
    cwd,
    box.env,
  )
  if (child.status !== 0) throw new Error(`Native review failed: ${child.stderr}\n${child.stdout}`)
  return JSON.parse(child.stdout) as Observation
}

function records(history: { operations: Array<{ record: CanonicalRecord | null }> }) {
  return history.operations.flatMap((entry) => (entry.record === null ? [] : [entry.record]))
}

function origin(observation: Observation): HistoryObservation {
  const found = observation.originHistories.find(
    (item) =>
      item.source.scope.repository === REVIEW_SCOPE.repository && item.source.scope.target === REVIEW_SCOPE.target,
  )
  if (!found) throw new Error('Original UW history is missing')
  return found
}

describe('native review disposition retention', () => {
  it('refuses correction before dispatch when the original history cannot be read', async ({ task }) => {
    const fixture = arrangeReviewFixture()
    try {
      await seedReviewFixture(fixture.box, fixture.cwd)
      const observed = await boundary(task, fixture.box, fixture.cwd, 'omp-disposition-original-unavailable')
      expect(observed.baseline.ok).toBe(true)
      expect(observed.result).toEqual({ ok: false, diagnostics: ['correction-disposition-history-incomplete'] })
      expect(observed.requested[0]).toEqual([
        REVIEW_SCOPE,
        { repository: REVIEW_SCOPE.repository, target: 'acme/app#7' },
      ])
      expect(observed.catalogueCalls).toBe(0)
      expect(observed.dispositionPublishes).toBe(0)
      expect(observed.correctionPublishes).toBe(0)
      expect(observed.activations).toBe(0)
      expect(observed.batches).toBe(0)
      expect(observed.starts).toBe(0)
      expect(observed.panels.length).toBeGreaterThan(0)
      for (const panel of observed.panels) expect(records(observed.after)).toContainEqual(panel)
    } finally {
      rmSync(fixture.box.root, { recursive: true, force: true })
    }
  })

  it('refuses a foreign synthesis producer without filing or applying authenticated findings', async ({ task }) => {
    const fixture = arrangeReviewFixture()
    try {
      await seedReviewFixture(fixture.box, fixture.cwd)
      const observed = await boundary(task, fixture.box, fixture.cwd, 'omp-disposition-foreign-synthesis')
      expect(observed.baseline.ok).toBe(true)
      expect(observed.result).toEqual({ ok: false, diagnostics: ['correction-disposition-producer-unconfirmed'] })
      expect(observed.dispositionPublishes).toBe(0)
      expect(observed.correctionPublishes).toBe(0)
      expect(observed.activations).toBe(0)
      expect(observed.batches).toBe(0)
      expect(observed.starts).toBe(0)
      expect(observed.panels.length).toBeGreaterThan(0)
      for (const panel of observed.panels) {
        expect(records(observed.after)).toContainEqual(panel)
        expect(panel.target).not.toBe(REVIEW_SCOPE.target)
      }
    } finally {
      rmSync(fixture.box.root, { recursive: true, force: true })
    }
  })

  it('retains authenticated findings and rule errors when synthesis breaks the partition', async ({ task }) => {
    const baseline = arrangeReviewFixture()
    const broken = arrangeReviewFixture()
    try {
      await seedReviewFixture(baseline.box, baseline.cwd)
      const valid = await run(task, baseline.box, baseline.cwd, false)
      expect(valid.initialAccepted).toBe('accepted')
      expect(valid.accepted).toBe('accepted')
      expect(valid.settlementError).toBeNull()
      expect(records(valid.after).some((item) => item.kind === 'review')).toBe(true)
      expect(
        records(origin(valid)).some(
          (item) => item.kind === 'cause-disposition' && item.payload.subject.kind === 'cause',
        ),
      ).toBe(true)

      await seedReviewFixture(broken.box, broken.cwd)
      const observed = await run(task, broken.box, broken.cwd, true)
      expect(observed.settlementError).toMatchObject({
        message: expect.stringContaining('decision-refused:unknown-reference,missing-cause'),
        errors: [expect.stringContaining('decision-refused:unknown-reference,missing-cause'), expect.any(String)],
        causeIsPrimary: true,
      })
      expect(observed.initialAccepted).toBe('accepted')
      expect(observed.accepted).toBe('accepted')
      const before = records(observed.before)
      const after = records(observed.after)
      const panels = before.filter((item) => item.kind === 'contribution' && item.payload.host.phase === 'panel')
      const decision = after.find((item) => item.kind === 'decision')
      if (decision?.kind !== 'decision') throw new Error('Native synthesis decision was not published')
      expect(decision.payload.judgment.causes[0]?.findingIds).toEqual(['unknown-finding'])
      expect(panels.length).toBeGreaterThan(0)
      const dispositions = records(origin(observed)).filter((item) => item.kind === 'cause-disposition')
      for (const panel of panels) {
        expect(
          dispositions.some(
            (item) =>
              item.payload.subject.kind === 'retained-finding' &&
              item.payload.subject.contribution.recordId === panel.recordId &&
              item.payload.outcome.state === 'pending-blocking',
          ),
        ).toBe(true)
        expect(after.find((item) => item.recordId === panel.recordId)).toEqual(panel)
        expect(panel.target).not.toBe(REVIEW_SCOPE.target)
      }
      expect(
        dispositions.some(
          (item) => item.payload.subject.kind === 'rule-error' && item.payload.outcome.state === 'pending-blocking',
        ),
      ).toBe(true)
      expect(
        dispositions.every(
          (item) => item.repository === REVIEW_SCOPE.repository && item.target === REVIEW_SCOPE.target,
        ),
      ).toBe(true)
      expect(JSON.stringify(observed.diagnostics)).toContain('decision-refused')
      expect(observed.fixRun).toBeNull()
      expect(observed.active).toBeNull()
      expect(
        after.some(
          (item) => item.kind === 'fix-request' || item.kind === 'correction-result' || item.kind === 'fix-result',
        ),
      ).toBe(false)
      expect(after.some((item) => item.kind === 'review')).toBe(false)
    } finally {
      rmSync(baseline.box.root, { recursive: true, force: true })
      rmSync(broken.box.root, { recursive: true, force: true })
    }
  })
})
