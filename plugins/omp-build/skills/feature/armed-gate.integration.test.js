import { describe, expect, it } from 'vitest'
import { buildRecord } from '../../dist/contracts.js'
import { actionInputDigest } from '../../engine/action-input.ts'
import { fixtureCatalogueGhResponse, standaloneReviewInputs } from '../../testing/action-input-fixtures.ts'
import { reviewGraph } from '../../testing/record-graphs.ts'
import {
  AUTHOR,
  gateGh,
  HEADS,
  linkedApproval,
  noProducerInput,
  PR,
  reviewHistory,
  SCOPE,
  WORKTREE,
} from './review-record-fixture.js'
import { requiredReviewRecords } from './workflow-records.js'
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
    await expect(nextReviewStep(WORKTREE, PR, { gh })).resolves.toMatchObject({
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
    await expect(nextReviewStep(WORKTREE, PR, { gh, git, ciFailed: true })).resolves.toMatchObject({
      action: 'stop',
      reason: 'ci-failed',
      disarmed: true,
    })
    expect(state).toEqual({ head: HEADS[2], label: false, auto: false })
    await expect(nextReviewStep(WORKTREE, PR, { gh, git })).resolves.toMatchObject({
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
    await expect(applyCiWatchExit(WORKTREE, PR, 1, { gh, git })).resolves.toMatchObject({
      status: 'ci-failed',
      disarmed: true,
    })
    expect(state).toEqual({ head: HEADS[2], label: false, auto: false })
    await expect(nextReviewStep(WORKTREE, PR, { gh, git })).resolves.toMatchObject({
      action: 'stop',
      reason: 'review-bound',
    })
  })

  it('clears the watcher arm when its selected review was edited', async () => {
    const linked = await linkedApproval(HEADS[0])
    const review = linked.pr.source.comments.find((entry) => entry.body.includes('kind=review '))
    if (!review) throw new Error('missing review fixture record')
    review.updatedAt = '2026-10-21T12:00:01Z'
    const { gh, git, state } = gateGh(linked.pr, { head: HEADS[0], armed: true, issueHistory: linked.issue })

    await expect(applyCiWatchExit(WORKTREE, PR, 5, { gh, git })).resolves.toMatchObject({
      status: 'timeout',
      disarmed: true,
    })
    expect(state).toEqual({ head: HEADS[0], label: false, auto: false })
  })

  it('clears the watcher arm when selected review revision metadata is missing', async () => {
    const linked = await linkedApproval(HEADS[0])
    const review = linked.pr.source.comments.find((entry) => entry.body.includes('kind=review '))
    if (!review) throw new Error('missing review fixture record')
    review.updatedAt = null
    const { gh, git, state } = gateGh(linked.pr, { head: HEADS[0], armed: true, issueHistory: linked.issue })

    await expect(applyCiWatchExit(WORKTREE, PR, 5, { gh, git })).resolves.toMatchObject({
      status: 'timeout',
      disarmed: true,
    })
    expect(state).toEqual({ head: HEADS[0], label: false, auto: false })
  })

  it('leaves the watcher arm unchanged when the head moves after landing admission', async () => {
    const linked = await linkedApproval(HEADS[0])
    expect(linked.input).not.toBe(noProducerInput(HEADS[0]))
    const { gh, git, state } = gateGh(linked.pr, {
      head: HEADS[0],
      armed: true,
      moveHeadAfterInputRead: HEADS[1],
      issueHistory: linked.issue,
    })
    await expect(applyCiWatchExit(WORKTREE, PR, 5, { gh, git })).resolves.toMatchObject({
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
    await expect(nextReviewStep(WORKTREE, PR, { gh })).resolves.toMatchObject({
      action: 'stop',
      reason: 'review-bound',
      disarmed: true,
    })
    expect(state).toEqual({ head: HEADS[2], label: false, auto: false })
  })

  it('preserves a proven bound and both diagnostics when a newer incomplete review cites an unreadable external history', async () => {
    const history = reviewHistory([])
    function appendRecord(record) {
      const built = buildRecord(record)
      if (!built.ok) throw new Error(JSON.stringify(built.diagnostics))
      const index = history.source.comments.length
      const data = Buffer.from(JSON.stringify(built.value)).toString('base64url')
      const timestamp = `2026-01-01T00:00:${String(index).padStart(2, '0')}Z`
      history.source.comments.push({
        locator: `bound-${index}`,
        nativeId: String(index + 1),
        author: AUTHOR,
        createdAt: timestamp,
        updatedAt: timestamp,
        body: `<!-- omp-build-record v=1 kind=${record.kind} id=${record.recordId} operationId=${record.operationId} part=1/1 data=${data} -->\n`,
      })
    }
    for (const [index, head] of HEADS.slice(0, 3).entries()) {
      const inputs = standaloneReviewInputs(SCOPE, head)
      const graph = reviewGraph({ prefix: `bound-${index}`, head, scope: SCOPE, inputs, label: 'issue(blocking)' })
      for (const record of graph.records) appendRecord(record)
    }
    const gate = gateGh(history, { head: HEADS[2], armed: true })
    const externalRequests = []
    const gh = async (cwd, args) => {
      const catalogue = fixtureCatalogueGhResponse(args)
      if (catalogue !== null) return catalogue
      if (args[0] === 'api' && args[1]?.startsWith('repos/acme/app/issues/999/comments?')) {
        externalRequests.push(args)
        throw new Error('fixture external history unavailable')
      }
      return gate.gh(cwd, args)
    }
    await expect(requiredReviewRecords(WORKTREE, PR, { gh })).resolves.toMatchObject({ reviews: 3, spent: true })
    expect(externalRequests).toHaveLength(0)

    const base = standaloneReviewInputs(SCOPE, HEADS[2])
    const manifest = {
      ...base.manifest,
      expandedContext: [
        {
          source: 'record',
          record: {
            scope: { repository: 'acme/app', target: 'acme/app#999' },
            kind: 'contribution',
            recordId: 'external-source',
          },
          selector: '/payload',
          digest: 'a'.repeat(64),
        },
      ],
    }
    const inputs = { ...base, manifest, fingerprint: actionInputDigest(manifest) }
    appendRecord(reviewGraph({ prefix: 'new-incomplete', head: HEADS[2], scope: SCOPE, inputs }).root)
    history.source.comments.push({
      locator: 'partial-review',
      nativeId: '404',
      author: AUTHOR,
      createdAt: '2026-01-01T00:02:00Z',
      updatedAt: null,
      body: '<!-- omp-build-record v=1 kind=review id=review-partial operationId=op-review-partial part=1/2 data=e30 -->\n',
    })

    let refusal
    try {
      await requiredReviewRecords(WORKTREE, PR, { gh })
    } catch (error) {
      refusal = error
    }
    expect(externalRequests.length).toBeGreaterThan(0)
    expect(refusal).toMatchObject({ reviewRecords: { ok: false, spent: true } })
    expect(refusal.citedHistory).not.toBe(true)
    expect(refusal.reviewRecords.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(['incomplete', 'github-read-failed']),
    )
    await expect(nextReviewStep(WORKTREE, PR, { gh })).resolves.toMatchObject({
      action: 'stop',
      reason: 'review-bound',
      disarmed: true,
    })
    expect(gate.state).toEqual({ head: HEADS[2], label: false, auto: false })
  })

  it('does not reset the bound when the head changes after the third red', async () => {
    const history = reviewHistory([
      { head: HEADS[0], verdict: 'Request changes' },
      { head: HEADS[1], verdict: 'Request changes' },
      { head: HEADS[2], verdict: 'Request changes' },
    ])
    const { gh } = gateGh(history, { head: HEADS[3], armed: false })
    await expect(nextReviewStep(WORKTREE, PR, { gh })).resolves.toMatchObject({
      action: 'stop',
      reason: 'review-bound',
    })
  })
})
