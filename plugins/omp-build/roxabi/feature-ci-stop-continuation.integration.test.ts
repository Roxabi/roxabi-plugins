import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { decodeHistory } from '../adapters/github/history-codec.ts'
import type { ActionInputs } from '../engine/action-input-schema.ts'
import { criterionReviewGraph, encodeCriterionRecords } from '../testing/criterion-approval.ts'
import { graphFromSimulatedIssues } from '../testing/criterion-dispositions.ts'
import { cleanupFeatureRecoveryRoots, trackFeatureRecoveryRoot } from '../testing/feature-recovery-fixture.ts'
import {
  arrangeReviewFixture,
  REVIEW_BRANCH,
  REVIEW_SCOPE,
  seedReviewFixture,
} from '../testing/feature-review-fixture.ts'
import { roxabiRecordFixtures, roxabiWorkflowFixtures } from '../testing/roxabi-presets.ts'
import { readSim, WORKFLOW, writeSim } from '../testing/sandbox/sandbox-repository.ts'
import type { Box } from '../testing/sandbox/sandbox-types.ts'
import { invoke } from './feature-recovery-process-fixture.ts'

const BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const PULL = { repository: 'acme/app', target: 'acme/app#7' }
const fixtures = roxabiWorkflowFixtures()
const { projection } = roxabiRecordFixtures()
afterEach(cleanupFeatureRecoveryRoots)

function history(box: Box, target: 'issue' | 'pull') {
  const scope = target === 'issue' ? REVIEW_SCOPE : PULL
  // The simulator assigns native IDs and immutable timestamps when GH first reads seeded comments.
  execFileSync('gh', ['api', `repos/acme/app/issues/${target === 'issue' ? 42 : 7}/comments?per_page=100&page=1`], {
    cwd: box.principal,
    env: box.env,
    encoding: 'utf8',
  })
  const comments = target === 'issue' ? readSim(box).issues['42']?.comments : readSim(box).prs['7']?.comments
  return decodeHistory({
    scope,
    expectedAuthor: 'operator',
    stopAuthor: null,
    complete: true,
    diagnostics: [],
    comments: (comments ?? []).map((comment, index) => ({
      locator: `${scope.target}:comment:${comment.id ?? index + 1}`,
      nativeId: comment.id === undefined ? null : String(comment.id),
      body: comment.body,
      author: comment.author,
      createdAt: comment.createdAt ?? null,
      updatedAt: comment.updatedAt ?? null,
    })),
  })
}

function mandate(box: Box) {
  const record = history(box, 'issue').operations.find((operation) => operation.record?.kind === 'mandate')?.record
  if (record?.kind !== 'mandate') throw new Error('feature mandate missing')
  return record
}

function captureInputs(box: Box, cwd: string, head: string): ActionInputs {
  const run = spawnSync(BUN, [WORKFLOW, 'captureReviewInput', cwd, JSON.stringify({ pr: 7, head })], {
    cwd,
    env: box.env,
    encoding: 'utf8',
  })
  if (run.status !== 0) throw new Error(`capture review input failed: ${run.stderr}`)
  const captured = JSON.parse(run.stdout) as { ok?: boolean; inputs?: ActionInputs }
  if (!captured.ok || !captured.inputs) throw new Error(`review input unavailable: ${run.stdout}`)
  return captured.inputs
}

function approve(box: Box, cwd: string, index: number) {
  const head = box.sha[REVIEW_BRANCH]
  if (!head) throw new Error('feature head missing')
  const issueHistory = history(box, 'issue')
  const review = criterionReviewGraph({
    mandate: mandate(box),
    issueRecords: issueHistory.operations.flatMap((operation) => (operation.record ? [operation.record] : [])),
    issueHistory,
    pullHistory: history(box, 'pull'),
    scope: PULL,
    head,
    inputs: captureInputs(box, cwd, head),
    projection,
    graph: graphFromSimulatedIssues(REVIEW_SCOPE, Object.values(readSim(box).issues)),
    contextHistories: [],
    author: 'operator',
    verdict: 'Approve (clean)',
    prefix: `ci-stop-review-${index}`,
  })
  writeSim(box, (state) => {
    const issue = state.issues['42']
    const pull = state.prs['7']
    if (!issue || !pull) throw new Error('review endpoints missing')
    issue.comments.push(...review.issueComments.map(({ body }) => ({ author: 'operator', body })))
    pull.comments.push(
      ...review.comments.map(({ body }) => ({
        author: 'operator',
        body,
        createdAt: '2026-10-22T11:00:00Z',
        updatedAt: '2026-10-22T11:00:00Z',
      })),
    )
  })
  return review.review.recordId
}

function setCi(box: Box, conclusion: 'failure' | 'success') {
  const head = box.sha[REVIEW_BRANCH]
  if (!head) throw new Error('feature head missing')
  writeSim(box, (state) => {
    state.checks[head] = [
      {
        name: 'ci',
        status: 'completed',
        conclusion,
        workflowName: 'ci',
        startedAt: '2026-10-22T12:00:00Z',
      },
    ]
  })
}

function stops(box: Box) {
  return history(box, 'pull').operations.filter(
    (operation) =>
      operation.status === 'complete' &&
      operation.record?.kind === 'stop' &&
      operation.record.payload.reason === 'ci-failed',
  )
}

function continueWithDifferentRuntime(box: Box, cwd: string, operation: 'continue' | 'watch') {
  const plugin = path.resolve(import.meta.dirname, '..')
  const installed = path.join(box.root, 'different-runtime', 'omp-build')
  cpSync(plugin, installed, { recursive: true })
  symlinkSync(
    path.resolve(plugin, '../../node_modules'),
    path.join(box.root, 'different-runtime', 'node_modules'),
    'dir',
  )
  const packagePath = path.join(installed, 'package.json')
  const manifest = JSON.parse(readFileSync(packagePath, 'utf8')) as { version: string }
  manifest.version = '0.18.9'
  writeFileSync(packagePath, JSON.stringify(manifest))
  const home = path.join(box.root, 'home-different-runtime')
  mkdirSync(home, { recursive: true })
  const runner = path.join(installed, 'testing', 'feature-recovery-runner.ts')
  const payload =
    operation === 'watch' ? { reference: '#42', pr: 7, code: 1 } : { reference: '#42', control: 'continue' }
  const run = spawnSync(BUN, [runner, operation, cwd, JSON.stringify(payload)], {
    cwd,
    env: { ...box.env, HOME: home },
    encoding: 'utf8',
  })
  if (run.status !== 0) throw new Error(`different runtime continuation failed: ${run.stderr}\n${run.stdout}`)
  return JSON.parse(run.stdout) as { kind: string; reason: string }
}

it.each([
  ['continue', 'active'],
  ['continue', 'paused'],
  ['continue', 'config-drift'],
  ['continue', 'publication-failure'],
  ['watch', 'active'],
  ['watch', 'paused'],
  ['watch', 'config-drift'],
] as const)('persists a spent CI bound only after engine admission (%s, %s)', async (operation, scenario) => {
  const { box, cwd } = arrangeReviewFixture()
  trackFeatureRecoveryRoot(box.root)
  await seedReviewFixture(box, cwd)

  approve(box, cwd, 1)
  approve(box, cwd, 2)
  const reviewId = approve(box, cwd, 3)
  if (scenario === 'paused') {
    const issueHistory = history(box, 'issue')
    const current = mandate(box)
    const request = fixtures.pauseRequested(current)
    const confirmed = fixtures.pauseConfirmed(current, request)
    const encoded = encodeCriterionRecords([request, confirmed], REVIEW_SCOPE, projection, 'operator', [], issueHistory)
    writeSim(box, (state) => {
      const issue = state.issues['42']
      if (!issue) throw new Error('feature issue missing')
      issue.comments.push(...encoded.comments.map(({ body }) => ({ author: 'operator', body })))
    })
  }
  setCi(box, 'failure')
  if (operation === 'watch') {
    writeSim(box, (state) => {
      const pull = state.prs['7']
      if (!pull) throw new Error('feature pull missing')
      pull.autoMerge = { enabledAt: '2026-10-22T11:30:00Z', matchHeadCommit: pull.headRefOid }
    })
    expect(readSim(box).prs['7']?.autoMerge).not.toBeNull()
  }
  const refusedStop = path.join(box.root, 'stop-post-refused')
  if (scenario === 'publication-failure') {
    const realGh = execFileSync('which', ['gh'], { env: box.env, encoding: 'utf8' }).trim()
    const bin = path.join(box.root, 'stop-failure-bin')
    mkdirSync(bin)
    const wrapper = path.join(bin, 'gh')
    writeFileSync(
      wrapper,
      '#!/bin/sh\nif [ "$1" = api ]; then case " $* " in *" --method POST "*"kind=stop "*) : > "$CI_STOP_REFUSED"; echo stop-post-refused >&2; exit 1;; esac; fi\nexec "$CI_STOP_REAL_GH" "$@"\n',
    )
    chmodSync(wrapper, 0o755)
    box.env.PATH = `${bin}:${box.env.PATH}`
    box.env.CI_STOP_REAL_GH = realGh
    box.env.CI_STOP_REFUSED = refusedStop
  }
  expect(stops(box)).toHaveLength(0)
  const result =
    scenario === 'config-drift'
      ? continueWithDifferentRuntime(box, cwd, operation)
      : invoke<{ kind: string; reason: string }>(
          box,
          cwd,
          path.join(box.root, 'home-red'),
          operation,
          operation === 'watch' ? { reference: '#42', pr: 7, code: 1 } : { reference: '#42', control: 'continue' },
        )
  if (operation === 'watch') expect(readSim(box).prs['7']?.autoMerge).toBeNull()
  if (scenario === 'publication-failure') {
    expect(existsSync(refusedStop)).toBe(true)
    expect(result).toMatchObject({ kind: 'blocked', reason: expect.stringMatching(/^ci-stop-unconfirmed:/) })
    expect(stops(box)).toHaveLength(0)
    return
  }
  if (scenario !== 'active') {
    expect(result).toMatchObject(
      scenario === 'paused'
        ? { kind: 'paused', reason: 'paused', confirmed: true }
        : { kind: 'blocked', reason: 'config-drift' },
    )
    expect(stops(box)).toHaveLength(0)
    return
  }
  expect(result).toMatchObject({ kind: 'terminal', reason: 'bound-stop' })
  expect(stops(box)).toMatchObject([
    { status: 'complete', record: { kind: 'stop', payload: { reason: 'ci-failed', reviewId } } },
  ])
  setCi(box, 'success')
  const later = invoke<{ kind: string; reason: string }>(box, cwd, path.join(box.root, 'home-green'), 'continue', {
    reference: '#42',
    control: 'continue',
  })
  expect(later).toMatchObject({ kind: 'terminal', reason: 'bound-stop' })
  expect(stops(box)).toMatchObject([
    { status: 'complete', record: { kind: 'stop', payload: { reason: 'ci-failed', reviewId } } },
  ])
})
