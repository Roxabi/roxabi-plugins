import { existsSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  attachBareOriginAtBase,
  postCalls,
  publish,
  readState,
  runReviewGate,
  setupReviewGateFixture,
  writeState,
} from '../testing/review-gate-fixture.ts'
import { PR_EDITED } from '../testing/review-gate-gh.ts'
import {
  advanceOriginNormativeStack,
  boundInput,
  cleanReview,
  reviewBodies,
  reviewSemanticContext,
  SPEC,
  seedMandate,
  setMandateIssue,
  standaloneNoProducerInput,
} from '../testing/review-gate-proof-arrangement.ts'

export function registerReviewGateMandateCases(): void {
  describe('review-gate CLI mandate and binding', () => {
    it('allows a green review whose input is the no-producer v2 hash', async () => {
      const fixture = setupReviewGateFixture()
      await seedMandate(fixture)
      const input = await boundInput(fixture)
      expect(input).toMatch(/^[0-9a-f]{64}$/)
      publish(fixture, cleanReview(fixture.head, 'one', input), 'SUCCESS')

      const result = runReviewGate(fixture)

      expect(result.stderr).toBe('')
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, allowed: true, ci: 'green' })
    })

    it('admits App installation reads without calling api user', async () => {
      const fixture = setupReviewGateFixture()
      writeState(fixture, { ...readState(fixture), installation: true })
      await seedMandate(fixture)
      const input = await boundInput(fixture)
      publish(fixture, cleanReview(fixture.head, 'app-installation', input), 'SUCCESS')

      const result = runReviewGate(fixture)

      expect(result.status).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({ ok: true, allowed: true, reviews: 1, ci: 'green' })
      expect(readState(fixture).calls.some((args) => args[0] === 'api' && args[1] === 'user')).toBe(false)
    })

    it('admits from an immutable copied tooling tree without inherited SDK dependencies', async () => {
      const fixture = setupReviewGateFixture()
      await seedMandate(fixture)
      const input = await boundInput(fixture)
      publish(fixture, cleanReview(fixture.head, 'isolated', input), 'SUCCESS')
      const copiedPlugin = path.join(fixture.tools, 'plugins', 'omp-build')

      expect(fixture.env.HOME).toBe(fixture.home)
      expect(fixture.env.NODE_PATH).toBe('')
      expect(existsSync(path.join(fixture.tools, 'node_modules'))).toBe(false)
      expect(existsSync(path.join(copiedPlugin, 'node_modules'))).toBe(false)
      expect(existsSync(path.join(copiedPlugin, 'dist', 'contracts.js'))).toBe(true)

      const result = runReviewGate(fixture)

      expect(result.status).toBe(0)
      expect(result.stderr).toBe('')
      expect(JSON.parse(result.stdout)).toEqual({ ok: true, allowed: true, reviews: 1, ci: 'green' })
      expect(postCalls(fixture)).toEqual([])
    })

    it.each(['SUCCESS', ''] as const)(
      'refuses %s CI when a valid standalone no-producer approval has no workflow-binding mandate',
      async (conclusion) => {
        const fixture = setupReviewGateFixture()
        const input = await standaloneNoProducerInput(fixture)
        expect(input).toMatch(/^[0-9a-f]{64}$/)
        publish(
          fixture,
          cleanReview(fixture.head, 'one', input),
          conclusion,
          conclusion === '' ? 'IN_PROGRESS' : 'COMPLETED',
        )

        const result = runReviewGate(fixture)
        const body = JSON.parse(result.stdout)

        expect(result.status).toBe(1)
        expect(result.stderr).toBe('')
        expect(body).toMatchObject({ ok: false, allowed: false, reason: 'missing' })
      },
    )

    it('allows a bound closed Spec when the accepted bytes are unchanged', async () => {
      const fixture = setupReviewGateFixture()
      await seedMandate(fixture)
      setMandateIssue(fixture, { state: 'CLOSED' })
      const input = await boundInput(fixture)
      publish(fixture, cleanReview(fixture.head, 'one', input), 'SUCCESS')

      const result = runReviewGate(fixture)

      expect(result.stderr).toBe('')
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, allowed: true, ci: 'green' })
    })

    it('refuses a closed Spec whose live body drifted from the accepted mandate', async () => {
      const fixture = setupReviewGateFixture()
      await seedMandate(fixture)
      const input = await boundInput(fixture)
      publish(fixture, cleanReview(fixture.head, 'one', input), 'SUCCESS')
      setMandateIssue(fixture, { state: 'CLOSED', body: `${SPEC}\n- [ ] clarified`, updatedAt: '2026-10-21T01:00:00Z' })

      const result = runReviewGate(fixture)

      expect(result.status).toBe(1)
      expect(result.stderr).toBe('')
      expect(JSON.parse(result.stdout)).toMatchObject({
        allowed: false,
        reason: 'materially-changed',
        detail: [{ code: 'materially-changed' }],
      })
    })

    it.each(['MISSING', 'UNKNOWN', 'MERGED'] as const)(
      'refuses Spec reads when the tracker state is %s',
      async (state) => {
        const fixture = setupReviewGateFixture()
        await seedMandate(fixture)
        setMandateIssue(fixture, { state })

        const semantic = await reviewSemanticContext(fixture)

        expect(semantic).toMatchObject({ ok: false, reason: 'unreadable' })
      },
    )

    it('does not grant landing from a closed tracker issue alone without a workflow-binding', async () => {
      const fixture = setupReviewGateFixture()
      const state = readState(fixture)
      state.prBody = 'Closes #42\n'
      state.prEditedAt = PR_EDITED
      state.issues['42'] = { body: SPEC, updatedAt: PR_EDITED, state: 'CLOSED', labels: [], comments: [] }
      writeState(fixture, state)
      const input = await standaloneNoProducerInput(fixture)
      publish(fixture, cleanReview(fixture.head, 'one', input), 'SUCCESS')

      const result = runReviewGate(fixture)

      expect(result.status).toBe(1)
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, allowed: false, reason: 'missing' })
    })

    it('refuses a stored null review input when no producer applies', async () => {
      const fixture = setupReviewGateFixture()
      await seedMandate(fixture)
      publish(fixture, cleanReview(fixture.head, 'one'), 'SUCCESS')

      const result = runReviewGate(fixture)

      expect(result.status).toBe(1)
      expect(JSON.parse(result.stdout)).toMatchObject({
        allowed: false,
        reason: 'unbound',
        detail: { producer: 'candidate' },
      })
    })

    it('allows pending CI when the no-producer hash matches the bound review', async () => {
      const fixture = setupReviewGateFixture()
      await seedMandate(fixture)
      publish(fixture, cleanReview(fixture.head, 'one', await boundInput(fixture)), '', 'IN_PROGRESS')

      const result = runReviewGate(fixture)

      expect(result.stderr).toBe('')
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, allowed: true, ci: 'pending' })
    })

    it.each([['green', 'SUCCESS', 'COMPLETED'] as const, ['pending', '', 'IN_PROGRESS'] as const])(
      'refuses %s when origin/main advances past GH baseRefOid while the mandate stays at the recorded tip',
      async (ci, conclusion, status) => {
        const fixture = setupReviewGateFixture()
        const origin = attachBareOriginAtBase(fixture)
        await seedMandate(fixture)
        const input = await boundInput(fixture)
        publish(fixture, cleanReview(fixture.head, 'one', input), conclusion, status)

        expect(JSON.parse(runReviewGate(fixture).stdout)).toMatchObject({ ok: true, allowed: true, ci })
        expect(advanceOriginNormativeStack(fixture, origin)).not.toBe(fixture.base)
        expect(readState(fixture)).toMatchObject({ base: fixture.base, head: fixture.head })

        const result = runReviewGate(fixture)

        expect(result.status).toBe(1)
        expect(result.stderr).toBe('')
        expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, allowed: false, reason: 'config-drift' })
      },
    )

    it('refuses the same head after the accepted Spec changes', async () => {
      const fixture = setupReviewGateFixture()
      await seedMandate(fixture)
      const input = await boundInput(fixture)
      publish(fixture, cleanReview(fixture.head, 'one', input), 'SUCCESS')
      await seedMandate(fixture, `${SPEC}\n- [ ] clarified`)

      const result = runReviewGate(fixture)

      expect(result.status).toBe(1)
      expect(JSON.parse(result.stdout)).toMatchObject({
        allowed: false,
        reason: 'unbound',
        detail: { producer: 'candidate' },
      })
    })

    it('refuses pending CI when the current canonical review requests changes', async () => {
      const fixture = setupReviewGateFixture()
      await seedMandate(fixture)
      const blockers = reviewBodies(fixture.head, 'blocker', await boundInput(fixture), 'Request changes')
      publish(fixture, blockers, '', 'IN_PROGRESS')

      const result = runReviewGate(fixture)

      expect(result.status).toBe(1)
      expect(JSON.parse(result.stdout)).toEqual({ ok: false, allowed: false, reason: 'review-state-wait' })
      expect(result.stderr).toBe('')
    })
  })
}
