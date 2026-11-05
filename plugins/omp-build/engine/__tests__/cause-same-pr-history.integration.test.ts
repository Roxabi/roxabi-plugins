import { expect, it } from 'vitest'
import { encodeParts } from '../../adapters/github/history-encoder.ts'
import { historyPage, SPEC, WORKTREE } from '../../skills/feature/review-record-fixture.js'
import { createGateGh } from '../../skills/feature/review-record-github-fixture.js'
import { nextReviewStep } from '../../skills/feature/workflow-review-state.js'
import type { DecodedHistory } from '../history-schema.ts'
import { validateFreshDecision } from '../review-decision.ts'
import { deriveReviewState, summarizeReviews } from '../review-state.ts'
import { recordsOf } from '../workflow-control.ts'
import { ref } from './cause-hold-fixture.ts'
import { scenario } from './cause-same-pr-history-fixture.ts'
import { reviewFacts } from './record-test-support.ts'
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

function schedulerTransport(source: DecodedHistory, own: DecodedHistory, head: string) {
  const state = { head, label: false, auto: false }
  const fixture = { pr: 44, issue: 42, repository: 'acme/app', author: 'operator', heads: [head], spec: SPEC }
  const gh = createGateGh({
    history: transportHistory(source),
    issueHistory: transportHistory(own),
    state,
    calls: [],
    fixture,
    historyPage,
  })
  return { gh, state }
}

it.each(['editorial', 'material'] as const)(
  'accounts for Spec A on the same PR after accepted %s B without granting A current authority',
  async (kind) => {
    const state = scenario(kind, 1)
    const source = state.source()
    const own = state.own()
    const freshInputs = state.reviewInputs('fresh-B-review', state.context)
    const head = freshInputs.manifest.code.head
    const historical = summarizeReviews(source, state.initial.catalogues, null, [own])
    expect(historical, JSON.stringify(historical)).toMatchObject({ ok: true, value: { reviews: 1 } })
    expect(historical.ok && historical.value.head).toBe(head)
    const facts = { ...reviewFacts(head), ...source.source.scope, input: freshInputs.fingerprint }
    expect(deriveReviewState(source, facts, state.initial.catalogues, [own])).toMatchObject({
      ok: true,
      next: 'review',
      summary: { reviews: 1 },
    })
    expect(
      validateFreshDecision(state.initial.decision, source, state.initial.catalogues, null, [own], source, [
        ref(state.originalDisposition),
      ]).ok,
    ).toBe(false)
    const incomplete = { ...own, source: { ...own.source, complete: false } }
    expect(summarizeReviews(source, state.initial.catalogues, null, [incomplete]).ok).toBe(false)
    const transport = schedulerTransport(source, own, head)
    await expect(nextReviewStep(WORKTREE, 44, { gh: transport.gh })).resolves.toMatchObject({
      action: 'fix',
      reviews: 1,
    })
    expect(transport.state.head).toBe(head)
    const fresh = state.addReview('fresh-B-review', state.context)
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
  },
)

it.each(['editorial', 'material'] as const)(
  'authorizes a fresh %s B review after the same PR advances its candidate HEAD',
  async (kind) => {
    const state = scenario(kind, 1)
    const source = state.source()
    const previous = summarizeReviews(source, state.initial.catalogues, null, [state.own()])
    if (!previous.ok || previous.value.head === null)
      throw new Error(`Expected authenticated A review HEAD: ${JSON.stringify(previous)}`)
    const head = previous.value.head === 'c'.repeat(40) ? 'd'.repeat(40) : 'c'.repeat(40)
    const freshInputs = state.reviewInputs('advanced-B-review', state.context, head)
    const transport = schedulerTransport(source, state.own(), head)
    await expect(nextReviewStep(WORKTREE, 44, { gh: transport.gh, reviewing: true })).resolves.toMatchObject({
      action: 'review',
      reason: 'head-moved',
      reviews: 1,
    })
    expect(transport.state.head).toBe(freshInputs.manifest.code.head)
    const fresh = state.addReview('advanced-B-review', state.context, head)
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
  },
)

it.each(['editorial', 'material'] as const)(
  'retains a spent review bound across same-PR %s Spec advancement',
  async (kind) => {
    const state = scenario(kind, 3)
    const source = state.source()
    const freshInputs = state.reviewInputs('fresh-B-review', state.context)
    const head = freshInputs.manifest.code.head
    const facts = { ...reviewFacts(head), ...source.source.scope, input: freshInputs.fingerprint }
    const result = deriveReviewState(source, facts, state.initial.catalogues, [state.own()])
    expect(result, JSON.stringify(result)).toMatchObject({
      ok: true,
      next: 'stop',
      summary: { reviews: 3, spent: true },
      requiredStop: { reason: 'review-bound' },
    })
    const transport = schedulerTransport(source, state.own(), head)
    await expect(nextReviewStep(WORKTREE, 44, { gh: transport.gh })).resolves.toMatchObject({
      action: 'stop',
      reason: 'review-bound',
      reviews: 3,
    })
    expect(transport.state.head).toBe(head)
  },
)
