import { publishGitHubRecord } from '../adapters/github/publish.ts'
import type { CauseContext } from '../engine/finding-target.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import { persistCauseDispositions } from '../roxabi/fix-disposition-execution.ts'
import { createFixDispositionStore } from '../roxabi/fix-disposition-store.ts'
import { withRoxabiGitHubPolicy } from '../roxabi/github-policy.ts'
import { createPublicationContextResolver } from '../roxabi/publication-context.ts'
import { loadReviewClassCatalogues } from '../roxabi/review-class-catalogues.ts'
import { reviewRecords } from '../skills/feature/workflow-records.js'
import { reviewStep } from '../skills/feature/workflow-review-state.js'
import { gh } from '../skills/feature/workflow-runtime.js'
import { citedHistory, history, reviewRecord } from './feature-review-race-history.ts'

type ReviewRecord = Extract<CanonicalRecord, { kind: 'review' }>
type DecisionRecord = Extract<CanonicalRecord, { kind: 'decision' }>

async function publishNewReview(
  cwd: string,
  round: number,
  review: ReviewRecord,
  decision: DecisionRecord,
  effective: CauseContext['effective'],
  initial: Awaited<ReturnType<typeof history>>,
): Promise<void> {
  const store = createFixDispositionStore(effective.own.uw, { cwd })
  const projection = createPublicationContextResolver({ cwd }, null)
  const id = `race-review-${round}`
  const newerDecision: DecisionRecord = {
    ...decision,
    recordId: `${id}-decision`,
    runId: id,
    operationId: `${id}-decision`,
    inputs: [...decision.inputs],
  }
  const decisionPublication = await publishGitHubRecord(
    newerDecision,
    withRoxabiGitHubPolicy({ cwd }),
    projection,
    await citedHistory(cwd, initial),
  )
  if (decisionPublication.status !== 'confirmed')
    throw new Error(`third-review-decision-refused:${JSON.stringify(decisionPublication.diagnostics)}`)
  const retained = await persistCauseDispositions(
    { causeContext: { original: effective.own.uw, effective } },
    { kind: 'decision', decision: newerDecision },
    { runId: id, operationId: `${id}-disposition`, nextRecordId: (kind) => `${id}-${kind}` },
    store,
  )
  if (!retained.ok) throw new Error(`third-review-disposition-refused:${JSON.stringify(retained.diagnostics)}`)
  const newerReview: ReviewRecord = {
    ...review,
    recordId: id,
    runId: id,
    operationId: id,
    inputs: review.inputs.map((input) => (input === decision.recordId ? newerDecision.recordId : input)),
    payload: { ...review.payload, decisionId: newerDecision.recordId, causeDispositionRefs: retained.value.refs },
  }
  const origin = await store.read([effective.own.uw])
  if (!origin.ok) throw new Error(`third-review-origin-unreadable:${JSON.stringify(origin.diagnostics)}`)
  const publication = await publishGitHubRecord(newerReview, withRoxabiGitHubPolicy({ cwd }), projection, origin.value)
  if (publication.status !== 'confirmed')
    throw new Error(`third-review-publication-refused:${JSON.stringify(publication.diagnostics)}`)
}

export async function nextReviewRecords(
  cwd: string,
): Promise<{ complete: boolean; reviews: number; action: string; reason: string }> {
  const initial = await history(cwd)
  const records = initial.operations.flatMap((operation) => (operation.record ? [operation.record] : []))
  const review = [...records].reverse().find(reviewRecord)
  if (review === undefined) throw new Error('latest-review-missing')
  const decision = records.find((record) => record.recordId === review.payload.decisionId)
  if (decision?.kind !== 'decision') throw new Error('latest-review-decision-missing')
  const root = records.find(
    (record) =>
      record.kind === 'review-attempt' &&
      record.payload.stage === 'initial' &&
      record.payload.purpose === 'review' &&
      review.payload.inventoryIds.includes(record.recordId),
  )
  if (
    root?.kind !== 'review-attempt' ||
    root.payload.stage !== 'initial' ||
    root.payload.purpose !== 'review' ||
    root.payload.inputSnapshot.manifest.spec.kind !== 'accepted'
  )
    throw new Error('race-review-accepted-origin-missing')
  const effective = root.payload.inputSnapshot.manifest.spec.effective
  for (const round of [2, 3]) await publishNewReview(cwd, round, review, decision, effective, initial)
  const current = await history(cwd)
  const externalHistories = await citedHistory(cwd, current)
  const catalogues = await loadReviewClassCatalogues({ histories: [current, ...externalHistories], cwd, gh })
  const summary = reviewRecords(current, { catalogues, externalHistories })
  if (!current.source.complete || !summary.ok || summary.value.reviews !== 3)
    throw new Error('third-review-history-invalid')
  const step = reviewStep(summary.value, { head: summary.value.head })
  if (step.action !== 'stop' || step.reason !== 'review-bound') throw new Error('third-review-bound-not-stopped')
  return { complete: current.source.complete, reviews: summary.value.reviews, action: step.action, reason: step.reason }
}
