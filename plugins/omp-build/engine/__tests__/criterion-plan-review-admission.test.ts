import { expect, test } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { fixtureReviewClassCatalogues } from '../../testing/action-input-fixtures.ts'
import { authenticatedPlanFixtures } from '../../testing/workflow-decision-cases/support/workflow-decision-fixtures.ts'
import { actionInputDigest, canonicalValueDigest } from '../action-input.ts'
import type { ActionInputs } from '../action-input-schema.ts'
import { selectedDeclarations } from '../criterion-decision-selection.ts'
import { currentPlanReceipt } from '../delivery-eligibility.ts'
import type { DecodedHistory } from '../history-schema.ts'
import type { Diagnostic } from '../record-values.ts'
import type { SpecEffective } from '../spec-effective-schema.ts'
import { bindExternalRef, type MandateRecord, mandateScope, recordsOf } from '../workflow-control.ts'
import { buildDeliveredLeaf } from './uw-delivered-leaf-fixture.ts'
import { must } from './workflow-test-support.ts'

function amendedPlanAt(
  mandate: MandateRecord,
  commit: string,
  histories: readonly DecodedHistory[],
  effective?: SpecEffective,
) {
  const { workflow, version } = authenticatedPlanFixtures(mandate, histories, effective, undefined, {
    repository: mandate.repository,
    base: commit,
    head: commit,
    referenceCommit: commit,
  })
  const draft = 'act-plan-1'
  const review = 'act-plan-review-1'
  const digest = workflow.publishedPlanDigest()
  const blocker = { sourceId: 'slot-architect', slotId: 'slot-architect', blockerId: 'plan-block-1' }
  const contributions = [
    workflow.blockingPlanContribution('slot-architect', 'R-workflow-plan-architect', blocker.blockerId),
    workflow.clearPlanContribution('slot-adversarial', 'R-workflow-plan-adversarial'),
  ]
  return [
    mandate,
    ...workflow.planDraftRecords(mandate, draft, version),
    workflow.planReviewStart(mandate, draft, digest, review, version),
    workflow.planReviewRecord(mandate, draft, digest, contributions, review, version),
    ...workflow.planAmendmentRecords(
      mandate,
      review,
      [blocker],
      [{ blocker, stepIds: ['step-1'], reason: 'the stale-region path is now mapped' }],
    ),
  ]
}

function reviewObservation(issueHistory: DecodedHistory, histories: readonly DecodedHistory[], inputs: ActionInputs) {
  const review = recordsOf(issueHistory).find(
    (item) =>
      item.kind === 'action-receipt' && item.payload.action === 'plan-review' && item.payload.phase === 'result',
  )
  if (review?.kind !== 'action-receipt' || review.payload.action !== 'plan-review' || review.payload.phase !== 'result')
    throw new Error('Expected a captured PLAN-REVIEW RESULT')
  const startId = review.payload.start.recordId
  const operation = issueHistory.operations.find((item) => item.recordId === startId)
  if (operation === undefined || operation.parts.length === 0) throw new Error('Expected observed START comments')
  const removed = new Set(operation.parts.map((part) => part.nativeId))
  const withoutStart = decodeHistory({
    ...issueHistory.source,
    comments: issueHistory.source.comments.filter((part) => !removed.has(part.nativeId)),
  })
  const ref = {
    source: 'record' as const,
    role: 'plan-review' as const,
    record: { scope: issueHistory.source.scope, recordId: review.recordId, kind: 'action-receipt' as const },
    selector: '/payload/contributions',
    digest: canonicalValueDigest(review.payload.contributions),
  }
  expect(bindExternalRef(ref.record, withoutStart).ok).toBe(true)
  const manifest = { ...inputs.manifest, deliveryData: [...inputs.manifest.deliveryData, ref] }
  return {
    replay: histories.map((history) => (history === issueHistory ? withoutStart : history)),
    inputs: { ...inputs, manifest, fingerprint: actionInputDigest(manifest) },
  }
}

function select(histories: readonly DecodedHistory[], inputs: ActionInputs) {
  const diagnostics: Diagnostic[] = []
  const selected = selectedDeclarations(histories, inputs, diagnostics, fixtureReviewClassCatalogues())
  return { selected, diagnostics }
}

test('selects a plan amendment and its implementation evidence only with the exact PLAN-REVIEW START', async () => {
  const fixture = await buildDeliveredLeaf('Approve (clean)', 42, false, undefined, undefined, amendedPlanAt)
  expect(fixture.implementation.payload.exactInputs).toMatchObject({ planActionId: 'act-plan-2' })
  const { histories } = fixture.observation
  const review = reviewObservation(fixture.review.issueHistory, histories, fixture.inputs)
  const mandate = { scope: mandateScope(fixture.mandate), recordId: fixture.mandate.recordId, kind: 'mandate' as const }

  const intact = select(histories, review.inputs)
  const amendment = must(currentPlanReceipt(histories, fixture.effective.own.version, mandate, []))
  expect(amendment?.payload.actionId).toBe('act-plan-2')
  expect(intact.selected.evidence).toHaveLength(1)
  expect(intact.diagnostics).toEqual([])

  const orphan = select(review.replay, fixture.inputs)
  const draft = must(currentPlanReceipt(review.replay, fixture.effective.own.version, mandate, []))
  expect(draft?.payload.actionId).toBe('act-plan-1')
  expect(orphan.selected.declarations).toEqual([])
  expect(orphan.selected.evidence).toEqual([])
  expect(orphan.diagnostics).toContainEqual(expect.objectContaining({ code: 'plan-review-start-unpaired' }))
})

test('reports an unpaired direct PLAN-REVIEW role without discarding independent draft evidence', async () => {
  const fixture = await buildDeliveredLeaf()
  const review = reviewObservation(fixture.review.issueHistory, fixture.observation.histories, fixture.inputs)
  const orphan = select(review.replay, review.inputs)
  expect(orphan.diagnostics).toContainEqual(expect.objectContaining({ code: 'plan-review-start-unpaired' }))
  expect(orphan.selected.evidence).toHaveLength(1)
})
