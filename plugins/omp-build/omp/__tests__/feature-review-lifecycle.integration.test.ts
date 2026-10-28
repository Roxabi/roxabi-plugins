import { execFileSync, spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import {
  arrangeReviewFixture,
  REVIEW_BRANCH as BRANCH,
  REVIEW_SCOPE as SCOPE,
  seedReviewFixture,
} from '../../testing/feature-review-fixture.ts'
import { git, readSim } from '../../testing/sandbox/sandbox-repository.ts'
import type { Box } from '../../testing/sandbox/sandbox-types.ts'

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

function invoke(box: Box, cwd: string, control: 'continue' | 'pause' | 'resume', operation = 'omp-review-lifecycle') {
  const run = spawnSync(BUN, [RUNNER, operation, cwd, JSON.stringify({ control })], {
    cwd,
    env: box.env,
    encoding: 'utf8',
  })
  if (run.status !== 0) throw new Error(`${operation} failed: ${run.stderr}\n${run.stdout}`)
  return JSON.parse(run.stdout) as {
    messages: string[]
    active: { operationId: string; tasks?: { tasks: Array<{ agent: string }> } } | null
    falsifyActive?: { operationId: string; tasks?: { tasks: Array<{ agent: string }> } } | null
    fixRun: { runId: string; operationId: string } | null
    comments: unknown[]
    barrier: boolean
    beforeRelease?: number
    commit?: string
    terminal?: { status: 'complete' | 'stopped'; recordId?: string; kind?: string }
    transitionOutcome?: 'next-batch' | 'terminal'
  }
}

function reviewHistory(box: Box) {
  const comments = readSim(box).prs['7']?.comments ?? []
  return decodeHistory({
    scope: { repository: 'acme/app', target: 'acme/app#7' },
    expectedAuthor: 'operator',
    stopAuthor: null,
    complete: true,
    diagnostics: [],
    comments: comments.map((comment, index) => ({
      locator: `acme/app#7:${index + 1}`,
      nativeId: String(index + 1),
      body: comment.body,
      author: comment.author,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })),
  })
}

function issueHistory(box: Box) {
  const comments = readSim(box).issues['42']?.comments ?? []
  return decodeHistory({
    scope: SCOPE,
    expectedAuthor: 'operator',
    stopAuthor: null,
    complete: true,
    diagnostics: [],
    comments: comments.map((comment, index) => ({
      locator: `acme/app#42:${index + 1}`,
      nativeId: String(index + 1),
      body: comment.body,
      author: comment.author,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })),
  }).operations.flatMap((operation) => (operation.record ? [operation.record] : []))
}

function pauseConfirmed(box: Box): boolean {
  const comments = readSim(box).issues['42']?.comments ?? []
  return decodeHistory({
    scope: SCOPE,
    expectedAuthor: 'operator',
    stopAuthor: null,
    complete: true,
    diagnostics: [],
    comments: comments.map((comment, index) => ({
      locator: `acme/app#42:${index + 1}`,
      nativeId: String(index + 1),
      body: comment.body,
      author: comment.author,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })),
  }).operations.some(
    (operation) =>
      operation.record?.kind === 'operator-control' && operation.record.payload.control === 'pause-confirmed',
  )
}

function assertPauseConfirmed(box: Box, messages: readonly string[]): void {
  if (pauseConfirmed(box)) return
  throw new Error(`confirmed pause missing; child messages: ${JSON.stringify(messages)}`)
}

describe('installed /feature review lifecycle through actual Bun and external boundaries', () => {
  it('keeps the activated fix after the preceding review terminal', async () => {
    const { box, cwd } = arrange()
    await seedReviewFixture(box, cwd)
    const observed = invoke(box, cwd, 'continue')
    const records = reviewHistory(box).operations.flatMap((operation) => (operation.record ? [operation.record] : []))
    const decision = records.find((record) => record.kind === 'decision')
    const review = records.find((record) => record.kind === 'review')
    const issueRecords = issueHistory(box)
    const request = records.find((record) => record.kind === 'fix-request')
    expect(
      request,
      `review-bound request observations: ${JSON.stringify({
        active: observed.active,
        fixRun: observed.fixRun,
        messages: observed.messages,
      })}`,
    ).toMatchObject({ target: 'acme/app#7' })
    expect(request?.payload).toMatchObject({ existingReviewId: review?.recordId, landing: false })
    expect(issueRecords.filter((record) => record.kind === 'mandate').map((record) => record.recordId)).toEqual([
      'mandate-feature-1',
    ])
    expect(issueRecords.some((record) => record.kind === 'operator-control')).toBe(false)
    expect(decision?.payload).toMatchObject({
      judgment: {
        findings: [{ id: 'selected-region-blocker', label: 'issue(blocking)' }],
        causes: [{ id: 'selected-region-cause', findingIds: ['selected-region-blocker'] }],
      },
    })
    expect(review?.payload).toMatchObject({ candidateGitSHA: box.sha[BRANCH], decisionId: decision?.recordId })
    const finalFinding =
      decision?.kind === 'decision'
        ? decision.payload.judgment.findings.find((finding) => finding.id === 'selected-region-blocker')
        : undefined
    const panelFindingIds = records.flatMap((record) =>
      record.kind === 'contribution' && record.payload.host.phase === 'panel'
        ? (record.payload.findings?.map((finding) => finding.id) ?? [])
        : [],
    )
    const finalFindingIds = finalFinding?.sourceFindingIds ?? []
    expect(panelFindingIds).toHaveLength(2)
    expect(new Set(panelFindingIds).size).toBe(panelFindingIds.length)
    expect([...finalFindingIds].sort()).toEqual([...panelFindingIds].sort())
    expect(
      observed.fixRun,
      `review-to-fix activation observations: ${JSON.stringify({
        active: observed.active,
        fixRun: observed.fixRun,
        messages: observed.messages,
      })}`,
    ).toMatchObject({ runId: expect.any(String), operationId: expect.any(String) })
    expect(request?.runId).toBe(observed.fixRun?.runId)
    expect(observed.active?.operationId).toBe(observed.fixRun?.operationId)
    expect(observed.messages.filter((message) => message.includes('OMP_BUILD_NATIVE_BATCH'))).toHaveLength(3)
  })

  it('pushes the owned correction only after native falsification', async () => {
    const { box, cwd } = arrange()
    await seedReviewFixture(box, cwd)
    const observed = invoke(box, cwd, 'continue', 'omp-review-apply-falsify')
    const records = reviewHistory(box).operations.flatMap((operation) => (operation.record ? [operation.record] : []))
    const request = records.find((record) => record.kind === 'fix-request')
    const result = records.find((record) => record.kind === 'fix-result')
    const remoteHead = git(box, cwd, ['ls-remote', 'origin', `refs/heads/${BRANCH}`]).split(/\s+/)[0]
    const observations = JSON.stringify({
      active: observed.active,
      falsifyActive: observed.falsifyActive,
      terminal: observed.terminal,
      transitionOutcome: observed.transitionOutcome,
      messages: observed.messages,
      comments: observed.comments,
      records,
    })
    expect(observed.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(observed.transitionOutcome, observations).toBe('next-batch')
    expect(observed.falsifyActive, observations).toMatchObject({
      tasks: { tasks: [{ agent: 'R-review-fix-falsify' }] },
    })
    expect(observed.terminal, observations).toMatchObject({ status: 'complete', kind: 'fix-result' })
    expect(observed.active).toBeNull()
    expect(remoteHead).toBe(observed.commit)
    expect(result, observations).toMatchObject({
      repository: SCOPE.repository,
      target: 'acme/app#7',
      payload: { candidateGitSHA: observed.commit },
    })
    expect(request?.payload).toMatchObject({ landing: false })
    expect(
      issueHistory(box)
        .filter((record) => record.kind === 'mandate')
        .map((record) => record.recordId),
    ).toEqual(['mandate-feature-1'])
    expect(issueHistory(box).some((record) => record.kind === 'operator-control')).toBe(false)
  })

  it('persists confirmed local pause for a fresh review without another dispatch', async () => {
    const { box, cwd } = arrange()
    await seedReviewFixture(box, cwd)
    const observed = invoke(box, cwd, 'pause')
    expect(observed.active).toBeNull()
    expect(observed.messages.filter((message) => message.includes('OMP_BUILD_NATIVE_BATCH'))).toHaveLength(1)
    assertPauseConfirmed(box, observed.messages)
  })

  it('fences continuation when final review publication is actually pending', async () => {
    const { box, cwd } = arrange()
    await seedReviewFixture(box, cwd)
    const observed = invoke(box, cwd, 'resume')
    expect(observed.barrier).toBe(true)
    expect(observed.beforeRelease).toBe(2)
    expect(observed.messages.filter((message) => message.includes('OMP_BUILD_NATIVE_BATCH'))).toHaveLength(2)
    expect(observed.active).toBeNull()
    assertPauseConfirmed(box, observed.messages)
  })
})
