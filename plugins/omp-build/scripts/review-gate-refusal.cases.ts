import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  approvals,
  boundInput,
  capturedCiFailure,
  cleanReview,
  seedMandate,
} from '../testing/review-gate-arrangement.ts'
import {
  git,
  postCalls,
  publish,
  readExternalHistory,
  readState,
  runReviewGate,
  runReviewStop,
  setupReviewGateFixture,
  writeState,
} from '../testing/review-gate-fixture.ts'
import { AUTOMATION, STOP_BOT } from '../testing/review-gate-gh.ts'

export function registerReviewGateRefusalCases(): void {
  describe('review-gate CLI refusals and persistent stops', () => {
    it('does not allow publication without a canonical review', () => {
      const fixture = setupReviewGateFixture()
      publish(fixture, [], 'SUCCESS')

      const result = runReviewGate(fixture)

      expect(result.status).toBe(1)
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, allowed: false })
      expect(result.stderr).toBe('')
    })

    it('refuses an unknown CI conclusion instead of retaining native auto-merge', () => {
      const fixture = setupReviewGateFixture()
      publish(fixture, cleanReview(fixture.head, 'one'), 'ACTION_REQUIRED')

      const result = runReviewGate(fixture)

      expect(result.status).toBe(1)
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, allowed: false, reason: 'review-history-refused' })
      expect(result.stderr).toBe('')
    })

    it('requires a fresh review when the review input changes before landing', async () => {
      const fixture = setupReviewGateFixture()
      await seedMandate(fixture)
      publish(fixture, cleanReview(fixture.head, 'one', await boundInput(fixture)), 'SUCCESS')
      const state = readState(fixture)
      state.prBody = `${state.prBody}changed after review\n`
      state.prEditedAt = '2026-10-21T00:01:00Z'
      writeState(fixture, state)

      const result = runReviewGate(fixture)

      expect(result.status).toBe(1)
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        allowed: false,
        reason: 'review-input-changed',
      })
      expect(result.stderr).toBe('')
    })

    it('refuses a failed CI after the third approving review', () => {
      const fixture = setupReviewGateFixture()
      publish(fixture, approvals(fixture.head), 'FAILURE')

      const result = runReviewGate(fixture)

      expect(result.status).toBe(1)
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, allowed: false, reason: 'ci-failed' })
      expect(result.stderr).toBe('')
    })

    it('surfaces the third-review CI stop before refusing unbound positive admission', () => {
      const fixture = setupReviewGateFixture()
      publish(fixture, approvals(fixture.head, 'a'.repeat(64)), 'FAILURE')

      const result = runReviewGate(fixture)

      expect(result.status).toBe(1)
      expect(JSON.parse(result.stdout)).toEqual({
        ok: false,
        allowed: false,
        reason: 'ci-failed',
        detail: { reviewId: 'three-final', detail: { reviews: 3, ci: 'red' } },
      })
      expect(postCalls(fixture)).toEqual([])
      expect(result.stderr).toBe('')
    })

    it('refuses a red current head when its third approving review binds the prior head', () => {
      const fixture = setupReviewGateFixture()
      const reviewedHead = fixture.head
      writeFileSync(path.join(fixture.candidate, 'unreviewed.txt'), 'unreviewed\n')
      git(fixture.candidate, ['add', '.'])
      git(fixture.candidate, ['commit', '-qm', 'unreviewed head'])
      const currentHead = git(fixture.candidate, ['rev-parse', 'HEAD'])
      publish(fixture, approvals(reviewedHead), 'FAILURE')
      const state = readState(fixture)
      state.head = currentHead
      state.calls = []
      writeState(fixture, state)

      const stopped = runReviewStop(fixture, capturedCiFailure(), currentHead)

      expect(stopped.status).toBe(1)
      expect(postCalls(fixture)).toEqual([])

      const gate = runReviewGate(fixture, currentHead)

      expect(gate.status).toBe(1)
      expect(JSON.parse(gate.stdout)).toEqual({ ok: false, allowed: false, reason: 'reviewed-head-mismatch' })
      expect(postCalls(fixture)).toEqual([])
    })

    it('retains the captured third-review CI stop across later green CI and a fresh head', async () => {
      const fixture = setupReviewGateFixture()
      publish(fixture, approvals(fixture.head), 'FAILURE', 'COMPLETED', 100)

      const stopped = runReviewStop(fixture, capturedCiFailure())

      expect(stopped.status).toBe(0)
      expect(JSON.parse(stopped.stdout)).toEqual({
        ok: true,
        stop: { reason: 'ci-failed', reviewId: 'three-final', detail: { reviews: 3, ci: 'red' } },
      })
      expect(postCalls(fixture)).toHaveLength(1)
      expect(readState(fixture).calls.some((argv) => argv[1]?.includes('page=2'))).toBe(true)

      writeFileSync(path.join(fixture.candidate, 'later.txt'), 'later\n')
      git(fixture.candidate, ['add', '.'])
      git(fixture.candidate, ['commit', '-qm', 'later candidate'])
      const freshHead = git(fixture.candidate, ['rev-parse', 'HEAD'])
      const state = readState(fixture)
      state.head = freshHead
      state.ci = { status: 'COMPLETED', conclusion: 'SUCCESS' }
      writeState(fixture, state)

      const gate = runReviewGate(fixture, freshHead)

      expect(gate.status).toBe(1)
      expect(JSON.parse(gate.stdout)).toEqual({
        ok: false,
        allowed: false,
        reason: 'ci-failed',
        detail: { reviewId: 'three-final', detail: { reviews: 3, ci: 'red' } },
      })
      expect(
        (await readExternalHistory(fixture)).operations.find((operation) => operation.kind === 'stop'),
      ).toMatchObject({
        status: 'complete',
        record: { kind: 'stop', payload: { reason: 'ci-failed', reviewId: 'three-final' } },
        parts: [{ author: STOP_BOT }],
      })
    })

    it('accepts a normal automation stop when the CI bot is also configured as a stop author', async () => {
      const fixture = setupReviewGateFixture()
      publish(fixture, approvals(fixture.head), 'FAILURE')
      expect(runReviewStop(fixture, capturedCiFailure()).status).toBe(0)
      const state = readState(fixture)
      for (const comment of state.comments) {
        if (comment.body.includes('kind=stop')) comment.user.login = AUTOMATION
      }
      state.ci = { status: 'COMPLETED', conclusion: 'SUCCESS' }
      writeState(fixture, state)

      const gate = runReviewGate(fixture)

      expect(JSON.parse(gate.stdout)).toMatchObject({ ok: false, allowed: false, reason: 'ci-failed' })
      expect(
        (await readExternalHistory(fixture)).operations.find((operation) => operation.kind === 'stop'),
      ).toMatchObject({
        status: 'complete',
        parts: [{ author: AUTOMATION }],
      })
    })

    it('keeps a bot-authored non-stop record observable without authority', async () => {
      const fixture = setupReviewGateFixture()
      publish(fixture, cleanReview(fixture.head, 'one'), 'SUCCESS')
      const state = readState(fixture)
      for (const comment of state.comments) comment.user.login = STOP_BOT
      writeState(fixture, state)

      const history = await readExternalHistory(fixture)

      expect(history.operations.find((operation) => operation.kind === 'review')).toMatchObject({
        authority: 'foreign',
        record: null,
      })
      expect(history.diagnostics).toEqual([])
    })

    it('refuses stale head and captured review-bound mismatches without posting a stop', () => {
      const fixture = setupReviewGateFixture()
      publish(fixture, approvals(fixture.head), 'FAILURE')
      const moved = readState(fixture)
      moved.head = 'f'.repeat(40)
      writeState(fixture, moved)

      const staleHead = runReviewStop(fixture, capturedCiFailure())

      expect(staleHead.status).toBe(1)
      expect(postCalls(fixture)).toEqual([])

      const restored = readState(fixture)
      restored.head = fixture.head
      restored.calls = []
      writeState(fixture, restored)

      const staleBound = runReviewStop(fixture, capturedCiFailure('one-final'))

      expect(staleBound.status).toBe(1)
      expect(postCalls(fixture)).toEqual([])
    })

    it('refuses when the complete native comment history cannot be read', () => {
      const fixture = setupReviewGateFixture()
      writeFileSync(path.join(fixture.stateDir, 'comments.fail'), '')

      const result = runReviewGate(fixture)

      expect(result.status).toBe(1)
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, allowed: false, reason: 'unreadable' })
      expect(result.stderr).toBe('')
    })
  })
}
