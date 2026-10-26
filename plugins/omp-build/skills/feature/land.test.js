import { describe, expect, it } from 'vitest'
import { AUTHOR, gateGh, HEADS, linkedApproval, noProducerInput, PR, reviewHistory } from './review-record-fixture.js'
import { landPr } from './workflow-landing.js'
import { featureLandOutcome } from './workflow-outcome.js'
import { nextReviewStep } from './workflow-review-state.js'

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

describe('landing review authority', () => {
  it('does not treat an armed label as approval when canonical history is empty', async () => {
    const { gh, git, state } = gateGh(reviewHistory([]), { head: HEADS[0], armed: true })
    await expect(nextReviewStep('/tmp/wt', PR, { gh, git })).resolves.toMatchObject({
      action: 'review',
      reason: 'no-review',
      disarmed: true,
    })
    expect(state).toEqual({ head: HEADS[0], label: false, auto: false })
  })

  it('requires a canonical approval of the current head before landing', async () => {
    const history = reviewHistory([{ head: HEADS[0], verdict: 'Approve (clean)' }])
    const { gh, git } = gateGh(history, { head: HEADS[1], armed: true })
    await expect(nextReviewStep('/tmp/wt', PR, { gh, git })).resolves.toMatchObject({
      action: 'review',
      reason: 'head-moved',
      disarmed: true,
    })
  })

  it('disarms when the retained review input changes at the same head', async () => {
    const history = reviewHistory([{ head: HEADS[0], verdict: 'Approve (clean)', input: 'a'.repeat(64) }])
    const { gh, git, state } = gateGh(history, { head: HEADS[0], armed: true })
    await expect(nextReviewStep('/tmp/wt', PR, { gh, git })).resolves.toMatchObject({
      action: 'review',
      reason: 'review-input-changed',
      disarmed: true,
    })
    expect(state).toEqual({ head: HEADS[0], label: false, auto: false })
  })

  it('refuses landing when the retained review input changes', async () => {
    const linked = linkedApproval(HEADS[0])
    const { gh, git, state } = gateGh(linked.pr, { head: HEADS[0], armed: true, issueHistory: linked.issue })
    const changedGh = async (cwd, args) => {
      const output = await gh(cwd, args)
      if (
        (args[0] === 'pr' && args[1] === 'view' && String(args.at(-1)).includes('body')) ||
        (args[0] === 'api' && args.includes('graphql') && args.some((arg) => String(arg).includes('lastEditedAt')))
      ) {
        const value = JSON.parse(output)
        if (args[0] === 'pr') value.body = 'changed after review'
        else value.data.repository.pullRequest.body = 'changed after review'
        return JSON.stringify(value)
      }
      return output
    }

    await expect(
      landPr('/tmp/wt', PR, {
        gh: changedGh,
        git,
        requiredContexts: ['ci'],
        landing: { mode: 'native', required_checks: ['ci'] },
      }),
    ).resolves.toMatchObject({ status: 'review-input-refused', reason: 'review-input-changed', disarmed: true })
    expect(state).toEqual({ head: HEADS[0], label: false, auto: false })
  })

  it('reports a base refusal as base-blocked', async () => {
    const linked = linkedApproval(HEADS[0])
    const { gh, git, state } = gateGh(linked.pr, { head: HEADS[0], armed: true, issueHistory: linked.issue })
    const refusingGit = async (cwd, args) =>
      args[0] === 'fetch' ? { code: 1, stdout: '', stderr: 'base unavailable' } : git(cwd, args)

    await expect(
      landPr('/tmp/wt', PR, {
        gh,
        git: refusingGit,
        requiredContexts: ['ci'],
        landing: { mode: 'native', required_checks: ['ci'] },
      }),
    ).resolves.toMatchObject({ status: 'base-blocked', disarmed: true })
    expect(state).toEqual({ head: HEADS[0], label: false, auto: false })
  })

  it('disarms a base read refusal without scheduling a review', async () => {
    const linked = linkedApproval(HEADS[0])
    const { gh, git, state } = gateGh(linked.pr, { head: HEADS[0], armed: true, issueHistory: linked.issue })
    const refusingGit = async (cwd, args) =>
      args[0] === 'fetch' ? { code: 1, stdout: '', stderr: 'base unavailable' } : git(cwd, args)

    await expect(nextReviewStep('/tmp/wt', PR, { gh, git: refusingGit })).resolves.toMatchObject({
      action: 'land',
      disarmed: true,
    })
    expect(state).toEqual({ head: HEADS[0], label: false, auto: false })
  })

  it('refuses landing without a workflow-binding (closed Spec alone is not landing authority)', async () => {
    const input = noProducerInput(HEADS[0])
    const history = reviewHistory([{ head: HEADS[0], verdict: 'Approve (clean)', input }])
    const { gh, git, state } = gateGh(history, { head: HEADS[0], armed: true })
    // Supply requiredContexts so native mode does not exit on empty checks before
    // mandate admission; keep gh/git fully injected (unit budget — no real Git).
    await expect(
      landPr('/tmp/wt', PR, {
        gh,
        git,
        requiredContexts: ['ci'],
        landing: { mode: 'native', required_checks: ['ci'] },
      }),
    ).resolves.toMatchObject({
      status: 'mandate-refused',
      reason: 'missing',
      disarmed: true,
    })
    expect(state).toEqual({ head: HEADS[0], label: false, auto: false })
  })

  it.each(['review', 'mandate', 'workflow-binding'])('refuses an edited %s record before landing', async (kind) => {
    const linked = linkedApproval(HEADS[0])
    const comment =
      kind === 'mandate'
        ? linked.issue.source.comments.find((entry) => entry.body.includes('kind=mandate '))
        : linked.pr.source.comments.find((entry) => entry.body.includes(`kind=${kind} `))
    if (!comment) throw new Error(`missing ${kind} fixture record`)
    comment.updatedAt = '2026-10-21T12:00:01Z'
    const { gh, git } = gateGh(linked.pr, { head: HEADS[0], armed: true, issueHistory: linked.issue })

    await expect(
      landPr('/tmp/wt', PR, {
        gh,
        git,
        requiredContexts: ['ci'],
        landing: { mode: 'native', required_checks: ['ci'] },
      }),
    ).resolves.toMatchObject({ reason: 'record-edited' })
  })

  it('refuses a review with absent native revision metadata before landing', async () => {
    const linked = linkedApproval(HEADS[0])
    const review = linked.pr.source.comments.find((entry) => entry.body.includes('kind=review '))
    if (!review) throw new Error('missing review fixture record')
    review.updatedAt = null
    const { gh, git } = gateGh(linked.pr, { head: HEADS[0], armed: true, issueHistory: linked.issue })

    await expect(
      landPr('/tmp/wt', PR, {
        gh,
        git,
        requiredContexts: ['ci'],
        landing: { mode: 'native', required_checks: ['ci'] },
      }),
    ).resolves.toMatchObject({ reason: 'record-unreadable' })
  })

  it('admits unedited review, mandate, and binding records', async () => {
    const linked = linkedApproval(HEADS[0])
    const { gh, git } = gateGh(linked.pr, { head: HEADS[0], armed: true, issueHistory: linked.issue })

    await expect(
      landPr('/tmp/wt', PR, {
        gh,
        git,
        requiredContexts: ['ci'],
        landing: { mode: 'native', required_checks: ['ci'] },
      }),
    ).resolves.toMatchObject({ status: 'auto-merge-failed', armed: false })
  })
  it('lands when the head moves after landing admission', async () => {
    const linked = linkedApproval(HEADS[0])
    expect(linked.input).not.toBe(noProducerInput(HEADS[0]))
    const { gh, git, state } = gateGh(linked.pr, {
      head: HEADS[0],
      armed: true,
      moveHeadAfterInputRead: HEADS[1],
      issueHistory: linked.issue,
    })
    await expect(nextReviewStep('/tmp/wt', PR, { gh, git })).resolves.toMatchObject({
      action: 'land',
    })
    expect(state).toEqual({ head: HEADS[0], label: true, auto: true })
  })

  it('clears a known arm when next review transition refuses incomplete history', async () => {
    const { gh, git, state } = gateGh(incompleteApprovalHistory(), { head: HEADS[0], armed: true })
    await expect(nextReviewStep('/tmp/wt', PR, { gh, git })).rejects.toThrow('review records refused')
    expect(state).toEqual({ head: HEADS[0], label: false, auto: false })
  })

  it('clears a known arm when landing refuses incomplete history', async () => {
    const { gh, git, state } = gateGh(incompleteApprovalHistory(), { head: HEADS[0], armed: true })
    await expect(
      landPr('/tmp/wt', PR, {
        gh,
        git,
        requiredContexts: ['ci'],
        landing: { mode: 'native', required_checks: ['ci'] },
      }),
    ).rejects.toThrow('review records refused')
    expect(state).toEqual({ head: HEADS[0], label: false, auto: false })
  })
})

describe('non-Epic landing outcome', () => {
  it('does not turn a refused mandate into a merge or another review', () => {
    expect(featureLandOutcome({ status: 'mandate-refused', reason: 'fix-only' })).toEqual({
      action: 'stop',
      claimMerged: false,
      reason: 'mandate-refused',
      reenter: 'none',
      reviewAgain: false,
      mandateReason: 'fix-only',
    })
    expect(featureLandOutcome({ status: 'mandate-refused', reason: 'missing' })).toEqual({
      action: 'stop',
      claimMerged: false,
      reason: 'mandate-refused',
      reenter: 'none',
      reviewAgain: false,
      mandateReason: 'missing',
    })
    expect(featureLandOutcome({ status: 'mandate-refused' })).toEqual({
      action: 'stop',
      claimMerged: false,
      reason: 'mandate-refused',
      reenter: 'none',
      reviewAgain: false,
      mandateReason: 'unknown-binding',
    })
  })

  it('blocks an unknown land status instead of claiming a watch or merge', () => {
    expect(featureLandOutcome({ status: 'approved' })).toEqual({
      action: 'blocked',
      claimMerged: false,
      reason: 'unknown-land-status',
      status: 'approved',
    })
    expect(featureLandOutcome({})).toEqual({
      action: 'blocked',
      claimMerged: false,
      reason: 'unknown-land-status',
      status: '',
    })
  })

  it('keeps a spent review bound and maps landing refusals to sticky stops', () => {
    expect(featureLandOutcome({ status: 'not-approved', reason: 'review-bound' })).toEqual({
      action: 'stop',
      claimMerged: false,
      reason: 'review-bound',
      reenter: 'none',
      reviewAgain: false,
    })
    expect(featureLandOutcome({ status: 'review-input-refused' })).toEqual({
      action: 'stop',
      claimMerged: false,
      reason: 'review-input-refused',
      reenter: 'same-head-review',
      bound: 'sticky',
    })
    expect(featureLandOutcome({ status: 'base-blocked' })).toEqual({
      action: 'stop',
      claimMerged: false,
      reason: 'base-blocked',
      reenter: 'after-named-cause',
      bound: 'sticky',
    })
  })

  it('sends red CI back to the review step and does not claim the merge', () => {
    expect(featureLandOutcome({ status: 'ci-failed' })).toEqual({
      action: 'next-review-step',
      ciFailed: true,
      claimMerged: false,
    })
  })

  it('does not start a watch without its id, and claims merged only after merge', () => {
    expect(featureLandOutcome({ status: 'watching' })).toEqual({
      action: 'blocked',
      claimMerged: false,
      reason: 'watch-missing',
      status: 'watching',
    })
    expect(featureLandOutcome({ status: 'timeout' })).toEqual({
      action: 'reattach-watch',
      claimMerged: false,
    })
    expect(featureLandOutcome({ status: 'merged' })).toEqual({
      action: 'report-merged',
      claimMerged: true,
      offerTail: true,
    })
  })
})
