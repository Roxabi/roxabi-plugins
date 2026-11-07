import { expect, it } from 'vitest'
import { encodeParts } from '../../adapters/github/history-encoder.ts'
import { historyPage, WORKTREE } from '../../skills/feature/review-record-fixture.js'
import { createGateGh } from '../../skills/feature/review-record-github-fixture.js'
import { nextReviewStep } from '../../skills/feature/workflow-review-state.js'
import type { DecodedHistory } from '../history-schema.ts'
import { validateFreshDecision } from '../review-decision.ts'
import { deriveReviewState, summarizeReviews } from '../review-state.ts'
import { resolveAcceptedSpec } from '../workflow-accepted-spec.ts'
import { recordsOf } from '../workflow-control.ts'
import { ref } from './cause-hold-fixture.ts'
import { scenario } from './cause-same-pr-history-fixture.ts'
import { reviewFacts } from './record-test-support.ts'
import { withSamePrNativeWorld } from './same-pr-native-world.ts'
import { must } from './workflow-test-support.ts'

function transportHistory(history: DecodedHistory) {
  return {
    ...history,
    source: {
      ...history.source,
      comments: recordsOf(history)
        .flatMap((record) => must(encodeParts(record, '', 65_536)))
        .map((body, index) => ({
          locator: `${history.source.scope.target}:comment:${index + 1}`,
          nativeId: String(index + 1),
          body,
          author: 'operator',
          createdAt: '2026-10-21T12:00:00Z',
          updatedAt: '2026-10-21T12:00:00Z',
        })),
    },
  }
}

function schedulerTransport(
  source: DecodedHistory,
  own: DecodedHistory,
  head: string,
  base: string,
  spec: string,
  response: (args: string[]) => string | null,
) {
  const state = { head, label: false, auto: false }
  const fixture = { pr: 44, issue: 42, repository: 'acme/app', author: 'operator', heads: [head], spec }
  const gh = createGateGh({
    history: transportHistory(source),
    issueHistory: transportHistory(own),
    state,
    calls: [],
    fixture,
    historyPage,
    native: { base, response },
  })
  return { gh, state }
}

it.each(['editorial', 'material'] as const)(
  'accounts for Spec A on the same PR after accepted %s B without granting A current authority',
  async (kind) =>
    withSamePrNativeWorld(async ({ native, base, nativeResponse }) => {
      const state = await scenario(kind, 1, native)
      const freshInputs = await state.reviewInputs('fresh-B-review', state.context)
      const source = state.source()
      const own = state.own()
      const head = freshInputs.manifest.code.head
      const historical = summarizeReviews(source, state.initial.catalogues, null, [own])
      expect(historical, JSON.stringify(historical)).toMatchObject({ ok: true, value: { reviews: 1 } })
      expect(historical.ok && historical.value.head).toBe(native.initialHead)
      const facts = { ...reviewFacts(head), ...source.source.scope, input: freshInputs.fingerprint }
      expect(deriveReviewState(source, facts, state.initial.catalogues, [own])).toMatchObject({
        ok: true,
        next: 'review',
        summary: { reviews: 1 },
      })
      const historicalDecision = validateFreshDecision(
        state.initial.decision,
        source,
        state.initial.catalogues,
        null,
        [own],
        source,
        [ref(state.originalDisposition)],
      )
      expect(historicalDecision).toMatchObject({ ok: true, value: { admissible: true } })
      const missingAOwn = {
        ...own,
        operations: own.operations.filter(
          (entry) => entry.recordId !== state.initial.context.effective.own.sourceAccepted.recordId,
        ),
      }
      const unsupportedA = validateFreshDecision(
        state.initial.decision,
        source,
        state.initial.catalogues,
        null,
        [missingAOwn],
        source,
        [ref(state.originalDisposition)],
      )
      expect(unsupportedA.ok && unsupportedA.value.admissible).toBe(false)
      const incomplete = { ...own, source: { ...own.source, complete: false } }
      expect(summarizeReviews(source, state.initial.catalogues, null, [incomplete]).ok).toBe(false)
      const accepted = resolveAcceptedSpec(state.initial.mandate, [own, source])
      if (!accepted.ok) throw new Error(`Expected accepted Spec B: ${JSON.stringify(accepted)}`)
      const transport = schedulerTransport(
        source,
        own,
        native.initialHead,
        base,
        accepted.spec.snapshot.raw.body,
        nativeResponse,
      )
      await expect(nextReviewStep(WORKTREE, 44, { gh: transport.gh })).resolves.toMatchObject({
        action: 'fix',
        reviews: 1,
      })
      expect(transport.state.head).toBe(native.initialHead)
      const fresh = await state.addReview('fresh-B-review', state.context)
      expect(fresh.inputs.fingerprint).toBe(freshInputs.fingerprint)
      if (fresh.review.kind !== 'review') throw new Error('Expected fresh B review')
      expect(
        validateFreshDecision(
          fresh.graph.decision,
          state.source(),
          state.initial.catalogues,
          null,
          [state.own()],
          state.source(),
          fresh.review.payload.causeDispositionRefs,
        ).ok,
      ).toBe(true)
      expect(summarizeReviews(state.source(), state.initial.catalogues, null, [state.own()])).toMatchObject({
        ok: true,
        value: { reviews: 2, verdict: 'Request changes' },
      })
    }),
)

it.each(['editorial', 'material'] as const)(
  'authorizes a fresh %s B review after the same PR advances its candidate HEAD',
  async (kind) =>
    withSamePrNativeWorld(async ({ native, heads, base, nativeResponse }) => {
      const state = await scenario(kind, 1, native)
      const source = state.source()
      const previous = summarizeReviews(source, state.initial.catalogues, null, [state.own()])
      if (!previous.ok || previous.value.head === null)
        throw new Error(`Expected authenticated A review HEAD: ${JSON.stringify(previous)}`)
      const head = heads[2]
      if (head === undefined) throw new Error('Expected advanced candidate HEAD')
      const freshInputs = await state.reviewInputs('advanced-B-review', state.context, head)
      const accepted = resolveAcceptedSpec(state.initial.mandate, [state.own(), source])
      if (!accepted.ok) throw new Error(`Expected accepted Spec B: ${JSON.stringify(accepted)}`)
      const transport = schedulerTransport(
        source,
        state.own(),
        head,
        base,
        accepted.spec.snapshot.raw.body,
        nativeResponse,
      )
      await expect(nextReviewStep(WORKTREE, 44, { gh: transport.gh, reviewing: true })).resolves.toMatchObject({
        action: 'review',
        reason: 'head-moved',
        reviews: 1,
      })
      expect(transport.state.head).toBe(freshInputs.manifest.code.head)
      const fresh = await state.addReview('advanced-B-review', state.context, head)
      expect(fresh.inputs.fingerprint).toBe(freshInputs.fingerprint)
      if (fresh.review.kind !== 'review') throw new Error('Expected fresh B review')
      expect(
        validateFreshDecision(
          fresh.graph.decision,
          state.source(),
          state.initial.catalogues,
          null,
          [state.own()],
          state.source(),
          fresh.review.payload.causeDispositionRefs,
        ).ok,
      ).toBe(true)
      expect(summarizeReviews(state.source(), state.initial.catalogues, null, [state.own()])).toMatchObject({
        ok: true,
        value: { reviews: 2, head },
      })
    }),
)

it.each(['editorial', 'material'] as const)(
  'retains a spent review bound across same-PR %s Spec advancement',
  async (kind) =>
    withSamePrNativeWorld(async ({ native, base, nativeResponse }) => {
      const state = await scenario(kind, 3, native)
      const source = state.source()
      const freshInputs = await state.reviewInputs('fresh-B-review', state.context)
      const head = freshInputs.manifest.code.head
      const facts = { ...reviewFacts(head), ...source.source.scope, input: freshInputs.fingerprint }
      const result = deriveReviewState(source, facts, state.initial.catalogues, [state.own()])
      expect(result, JSON.stringify(result)).toMatchObject({
        ok: true,
        next: 'stop',
        summary: { reviews: 3, spent: true },
        requiredStop: { reason: 'review-bound' },
      })
      const accepted = resolveAcceptedSpec(state.initial.mandate, [state.own(), source])
      if (!accepted.ok) throw new Error(`Expected accepted Spec B: ${JSON.stringify(accepted)}`)
      const transport = schedulerTransport(
        source,
        state.own(),
        head,
        base,
        accepted.spec.snapshot.raw.body,
        nativeResponse,
      )
      await expect(nextReviewStep(WORKTREE, 44, { gh: transport.gh })).resolves.toMatchObject({
        action: 'stop',
        reason: 'review-bound',
        reviews: 3,
      })
      expect(transport.state.head).toBe(head)
    }),
)
