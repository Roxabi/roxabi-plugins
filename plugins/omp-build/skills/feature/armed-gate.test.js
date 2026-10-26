import { describe, expect, it } from 'vitest'
import { AUTHOR, gateGh, HEADS, linkedApproval, noProducerInput, PR, reviewHistory } from './review-record-fixture.js'
import { nextReviewStep } from './workflow-review-state.js'
import { applyCiWatchExit } from './workflow-watch.js'

describe('durable review stop', () => {
  it('keeps a third red sticky after a later green record and confirms gate clearing', async () => {
    const history = reviewHistory([
      { head: HEADS[0], verdict: 'Request changes' },
      { head: HEADS[1], verdict: 'Request changes' },
      { head: HEADS[2], verdict: 'Request changes' },
      { head: HEADS[2], verdict: 'Approve (clean)' },
    ])
    const { gh, state } = gateGh(history, { head: HEADS[2], armed: true })
    await expect(nextReviewStep('/tmp/wt', PR, { gh })).resolves.toMatchObject({
      action: 'stop',
      reason: 'review-bound',
      disarmed: true,
    })
    expect(state.label).toBe(false)
    expect(state.auto).toBe(false)
  })

  it('persists a third current approval plus observed CI red before disarming', async () => {
    const history = reviewHistory([
      { head: HEADS[0], verdict: 'Approve (clean)' },
      { head: HEADS[1], verdict: 'Approve (clean)' },
      { head: HEADS[2], verdict: 'Approve (clean)' },
    ])
    const { gh, git, state } = gateGh(history, { head: HEADS[2], armed: true })
    await expect(nextReviewStep('/tmp/wt', PR, { gh, git, ciFailed: true })).resolves.toMatchObject({
      action: 'stop',
      reason: 'ci-failed',
      disarmed: true,
    })
    expect(state).toEqual({ head: HEADS[2], label: false, auto: false })
    await expect(nextReviewStep('/tmp/wt', PR, { gh, git })).resolves.toMatchObject({
      action: 'stop',
      reason: 'review-bound',
    })
  })

  it('persists the observed watcher CI failure before clearing its gate', async () => {
    const history = reviewHistory([
      { head: HEADS[0], verdict: 'Approve (clean)' },
      { head: HEADS[1], verdict: 'Approve (clean)' },
      { head: HEADS[2], verdict: 'Approve (clean)' },
    ])
    const { gh, git, state } = gateGh(history, { head: HEADS[2], armed: true })
    await expect(applyCiWatchExit('/tmp/wt', PR, 1, { gh, git })).resolves.toMatchObject({
      status: 'ci-failed',
      disarmed: true,
    })
    expect(state).toEqual({ head: HEADS[2], label: false, auto: false })
    await expect(nextReviewStep('/tmp/wt', PR, { gh, git })).resolves.toMatchObject({
      action: 'stop',
      reason: 'review-bound',
    })
  })

  it('clears the watcher arm when its selected review was edited', async () => {
    const linked = linkedApproval(HEADS[0])
    const review = linked.pr.source.comments.find((entry) => entry.body.includes('kind=review '))
    if (!review) throw new Error('missing review fixture record')
    review.updatedAt = '2026-10-21T12:00:01Z'
    const { gh, git, state } = gateGh(linked.pr, { head: HEADS[0], armed: true, issueHistory: linked.issue })

    await expect(applyCiWatchExit('/tmp/wt', PR, 5, { gh, git })).resolves.toMatchObject({
      status: 'timeout',
      disarmed: true,
    })
    expect(state).toEqual({ head: HEADS[0], label: false, auto: false })
  })

  it('leaves the watcher arm unchanged when the head moves after landing admission', async () => {
    const linked = linkedApproval(HEADS[0])
    expect(linked.input).not.toBe(noProducerInput(HEADS[0]))
    const { gh, git, state } = gateGh(linked.pr, {
      head: HEADS[0],
      armed: true,
      moveHeadAfterInputRead: HEADS[1],
      issueHistory: linked.issue,
    })
    await expect(applyCiWatchExit('/tmp/wt', PR, 5, { gh, git })).resolves.toMatchObject({
      status: 'timeout',
    })
    expect(state).toEqual({ head: HEADS[0], label: true, auto: true })
  })

  it('keeps a proven bound when a newer review operation is incomplete', async () => {
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
    const { gh, state } = gateGh(history, { head: HEADS[2], armed: true })
    await expect(nextReviewStep('/tmp/wt', PR, { gh })).resolves.toMatchObject({
      action: 'stop',
      reason: 'review-bound',
      disarmed: true,
    })
    expect(state).toEqual({ head: HEADS[2], label: false, auto: false })
  })

  it('does not reset the bound when the head changes after the third red', async () => {
    const history = reviewHistory([
      { head: HEADS[0], verdict: 'Request changes' },
      { head: HEADS[1], verdict: 'Request changes' },
      { head: HEADS[2], verdict: 'Request changes' },
    ])
    const { gh } = gateGh(history, { head: HEADS[3], armed: false })
    await expect(nextReviewStep('/tmp/wt', PR, { gh })).resolves.toMatchObject({
      action: 'stop',
      reason: 'review-bound',
    })
  })
})
