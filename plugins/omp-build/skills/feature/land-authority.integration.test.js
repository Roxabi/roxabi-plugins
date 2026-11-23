import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AUTHOR,
  gateGh,
  HEADS,
  linkedApproval,
  noProducerInput,
  PR,
  reviewHistory,
  WORKTREE,
} from './review-record-fixture.js'
import { nextReviewStep } from './workflow-review-state.js'

beforeEach(() => {
  vi.stubEnv('HEAD_AUTH_REPOSITORY_ID', '1')
  vi.stubEnv('HEAD_AUTH_OPERATOR_IDS', '[101]')
  vi.stubEnv('HEAD_AUTH_APP_ID', '200')
  vi.stubEnv('HEAD_AUTH_BOT_USER_ID', '201')
})
afterEach(() => vi.unstubAllEnvs())

function incompleteApprovalHistory() {
  const history = reviewHistory([{ head: HEADS[0], verdict: 'Approve (clean)' }])
  history.source.comments.push({
    locator: 'incomplete-review',
    nativeId: '515',
    author: AUTHOR,
    createdAt: '2026-01-01T00:04:00Z',
    updatedAt: null,
    body: '<!-- omp-build-record v=1 kind=review id=review-incomplete operationId=op-review-incomplete part=1/2 data=e30 -->\n',
  })
  return history
}

describe('legacy PR review authority', () => {
  it('lands when the head moves after landing admission', async () => {
    const linked = await linkedApproval(HEADS[0])
    expect(linked.input).not.toBe(noProducerInput(HEADS[0]))
    const { gh, git, state } = gateGh(linked.pr, {
      head: HEADS[0],
      armed: true,
      moveHeadAfterInputRead: HEADS[1],
      issueHistory: linked.issue,
    })
    await expect(nextReviewStep(WORKTREE, PR, { gh, git })).resolves.toMatchObject({
      action: 'land',
    })
    expect(state).toEqual({ head: HEADS[0], label: true, auto: true })
  })

  it('clears a known arm when next review transition refuses incomplete history', async () => {
    const { gh, git, state } = gateGh(incompleteApprovalHistory(), { head: HEADS[0], armed: true })
    await expect(nextReviewStep(WORKTREE, PR, { gh, git })).rejects.toThrow('review records refused')
    expect(state).toEqual({ head: HEADS[0], label: false, auto: false })
  })
})
