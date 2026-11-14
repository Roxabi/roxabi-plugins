import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { failedCheckEvidenceDigest } from '../dist/contracts.js'
import type { DecodedHistory } from '../engine/history-schema.ts'
import {
  AUTHOR,
  gateGh,
  HEADS,
  ISSUE_SCOPE,
  PR,
  reviewHistory,
  SCOPE,
  WORKTREE,
} from '../skills/feature/review-record-fixture.js'
import { persistObservedCiStop } from '../skills/feature/workflow-review-state.js'
import { readReviewObservation } from './feature-review-observation.ts'

beforeEach(() => {
  vi.stubEnv('HEAD_AUTH_REPOSITORY_ID', '1')
  vi.stubEnv('HEAD_AUTH_OPERATOR_IDS', '[101]')
  vi.stubEnv('HEAD_AUTH_APP_ID', '200')
  vi.stubEnv('HEAD_AUTH_BOT_USER_ID', '201')
})
afterEach(() => vi.unstubAllEnvs())

function redWorld(
  history: DecodedHistory,
  head: string,
  failFirstReviewRead = false,
  armed = false,
  failGateAndWithdrawal = false,
) {
  const fixture = gateGh(history, { head, armed })
  const calls: string[][] = []
  let seenCiEvidence = false
  let readingReview = false
  let gateFailed = false
  function rejectGateRead(args: string[]) {
    if (gateFailed) throw new Error('withdrawal unavailable')
    if (failGateAndWithdrawal && args[0] === 'pr' && args[1] === 'view' && String(args.at(-1)).includes('headRefOid')) {
      gateFailed = true
      throw new Error('gate unavailable')
    }
  }
  const gh = async (cwd: string, args: string[]) => {
    calls.push(args)
    rejectGateRead(args)
    if (seenCiEvidence && args[0] === 'repo' && args[1] === 'view') readingReview = true
    if (args[0] === 'pr' && args[1] === 'view' && args.at(-1) === 'statusCheckRollup') {
      return JSON.stringify({ statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }] })
    }
    if (args[0] === 'api' && args[1] === 'graphql' && args.some((arg) => arg.includes('statusCheckRollup'))) {
      seenCiEvidence = true
      return JSON.stringify({
        data: {
          repository: {
            object: {
              statusCheckRollup: {
                contexts: {
                  nodes: [
                    { __typename: 'CheckRun', id: 'check-1', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        },
      })
    }
    if (
      failFirstReviewRead &&
      readingReview &&
      args[0] === 'api' &&
      String(args[1]).includes(`/issues/${PR}/comments?`)
    ) {
      failFirstReviewRead = false
      throw new Error('review comments unavailable')
    }
    return fixture.gh(cwd, args)
  }
  const delivery = {
    number: PR,
    scope: SCOPE,
    head,
    branch: 'feat/save',
    base: 'main',
    history,
    issueScope: ISSUE_SCOPE,
  }
  const context = {
    cwd: WORKTREE,
    gh,
    git: fixture.git,
    engine: { failedCheckEvidenceDigest },
  } as unknown as Parameters<typeof readReviewObservation>[2]
  return { observe: () => readReviewObservation(delivery, false, context, []), calls, state: fixture.state }
}

function stopPosts(calls: string[][]) {
  return calls.filter((args) => args.includes('POST') && args.some((arg) => /kind=stop\b/.test(arg)))
}

it('observes red CI without a current approval as review facts', async () => {
  const world = redWorld(reviewHistory([]), HEADS[0])
  await expect(world.observe()).resolves.toMatchObject({
    ciWatchStatus: 'red',
    failedChecks: ['test'],
    review: 'review',
  })
  expect(stopPosts(world.calls)).toEqual([])
})

it('requires review when red CI is on a head newer than the approval', async () => {
  const history = reviewHistory([{ head: HEADS[0], verdict: 'Approve (clean)' }])
  const world = redWorld(history, HEADS[1])
  await expect(world.observe()).resolves.toMatchObject({ ciWatchStatus: 'red', review: 'review' })
  expect(stopPosts(world.calls)).toEqual([])
})

it('keeps requested changes as an ordinary review fix on red CI', async () => {
  const history = reviewHistory([{ head: HEADS[0], verdict: 'Request changes' }])
  const world = redWorld(history, HEADS[0])
  await expect(world.observe()).resolves.toMatchObject({ ciWatchStatus: 'red', review: 'fix' })
  expect(stopPosts(world.calls)).toEqual([])
})

it('reports a transient review read failure instead of inventing a spent bound', async () => {
  const history = reviewHistory([{ head: HEADS[0], verdict: 'Approve (clean)' }])
  const world = redWorld(history, HEADS[0], true)
  await expect(world.observe()).resolves.toMatchObject({
    kind: 'blocked',
    reason: expect.stringContaining('review comments unavailable'),
  })
  expect(stopPosts(world.calls)).toEqual([])
})

it('specializes an approved current head with red CI as a fix', async () => {
  const history = reviewHistory([{ head: HEADS[0], verdict: 'Approve (clean)' }])
  const world = redWorld(history, HEADS[0])
  await expect(world.observe()).resolves.toMatchObject({ ciWatchStatus: 'red', review: 'fix-ci' })
  expect(stopPosts(world.calls)).toEqual([])
})

it('withdraws landing arms even when the review read fails', async () => {
  const history = reviewHistory([{ head: HEADS[0], verdict: 'Approve (clean)' }])
  const world = redWorld(history, HEADS[0], true, true)
  await expect(world.observe()).resolves.toMatchObject({ kind: 'blocked' })
  expect(world.state).toMatchObject({ label: false, auto: false })
  expect(stopPosts(world.calls)).toEqual([])
})

it('preserves both gate read and withdrawal failures', async () => {
  const world = redWorld(reviewHistory([]), HEADS[0], false, true, true)
  const result = await world.observe()
  expect(result).toMatchObject({ kind: 'blocked' })
  expect(JSON.stringify(result)).toContain('gate unavailable')
  expect(JSON.stringify(result)).toContain('withdrawal unavailable')
  expect(stopPosts(world.calls)).toEqual([])
})

it('preserves a proven spent review bound with an incomplete newer record', async () => {
  const history = reviewHistory([
    { head: HEADS[0], verdict: 'Request changes' },
    { head: HEADS[1], verdict: 'Request changes' },
    { head: HEADS[2], verdict: 'Request changes' },
  ])
  history.source.comments.push({
    locator: 'partial-review',
    nativeId: '404',
    author: AUTHOR,
    createdAt: '2026-01-01T00:02:00Z',
    updatedAt: null,
    body: '<!-- omp-build-record v=1 kind=review id=review-partial operationId=op-review-partial part=1/2 data=e30 -->\n',
  })
  const world = redWorld(history, HEADS[2])
  await expect(world.observe()).resolves.toMatchObject({ review: 'stop', reviewId: null })
  expect(stopPosts(world.calls)).toEqual([])
})

it('does not publish a CI stop business record while observing a third approval and red CI', async () => {
  const history = reviewHistory([
    { head: HEADS[0], verdict: 'Approve (clean)' },
    { head: HEADS[1], verdict: 'Approve (clean)' },
    { head: HEADS[2], verdict: 'Approve (clean)' },
  ])
  const world = redWorld(history, HEADS[2])
  await expect(world.observe()).resolves.toMatchObject({
    ciWatchStatus: 'red',
    review: 'stop',
    reviewId: 'review-3-final',
  })
  expect(stopPosts(world.calls)).toEqual([])
})

it('refuses to publish a CI stop when the observed head or review changed', async () => {
  const history = reviewHistory([
    { head: HEADS[0], verdict: 'Approve (clean)' },
    { head: HEADS[1], verdict: 'Approve (clean)' },
    { head: HEADS[2], verdict: 'Approve (clean)' },
  ])
  const fixture = gateGh(history, { head: HEADS[2], armed: false })
  await expect(
    persistObservedCiStop(WORKTREE, PR, {
      gh: fixture.gh,
      expectedHead: HEADS[1],
      expectedReviewId: 'review-3-final',
    }),
  ).rejects.toThrow('observed CI stop review or head changed')
  await expect(
    persistObservedCiStop(WORKTREE, PR, {
      gh: fixture.gh,
      expectedHead: HEADS[2],
      expectedReviewId: 'review-2-final',
    }),
  ).rejects.toThrow('observed CI stop review or head changed')
  expect(stopPosts(fixture.calls)).toEqual([])
})
