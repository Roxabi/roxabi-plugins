import {
  buildRecord,
  type CanonicalRecord,
  type DecodedHistory,
  decisionSchema,
  type Policy,
  type RecordDraft,
  reviewInventoryHasContextNegative,
  type Scope,
  validateDecision,
} from '../dist/contracts.js'
import type { Result } from '../engine/result.ts'
import type { PublishedContribution } from './review-contract.ts'
import { type ReviewIdentity, recordBase, requireRecord } from './review-records'

type FinalizationInput = {
  context: {
    subject: { kind: 'pull-request' } | { kind: 'epic-range'; range: string }
    candidateGitSHA: string
    input: string | null
  }
  policy: Policy
  canonicalClasses: readonly string[]
  authorize(stage: 'synthesis'): Promise<{ ok: true } | { ok: false; reason: string }>
}

function requireFinalContext(history: DecodedHistory, inventories: readonly string[]): void {
  if (!history.source.complete || reviewInventoryHasContextNegative(history, inventories))
    throw new Error('final-publication-refused:action-context-missing')
}

export async function finalizeReview(input: {
  review: FinalizationInput
  identity: ReviewIdentity
  scope: Scope
  contributions: readonly PublishedContribution[]
  inventories: readonly string[]
  canContinue: () => boolean
  readHistory: () => Promise<DecodedHistory>
  publish(record: CanonicalRecord, failurePrefix: string, externalHistories?: readonly DecodedHistory[]): Promise<void>
  readExternalHistories(history: DecodedHistory): Promise<Result<readonly DecodedHistory[]>>
  onDecisionConfirmed(decisionId: string): void
}): Promise<void> {
  if (!input.canContinue()) return
  const authorization = await input.review.authorize('synthesis')
  if (!authorization.ok) throw new Error(`final-publication-refused:${authorization.reason}`)
  const beforeFinal = await input.readHistory()
  requireFinalContext(beforeFinal, input.inventories)
  const contribution = input.contributions.find((item) => item.child.expectedId === 'synthesis')
  if (!contribution || contribution.child.structured === null) throw new Error('synthesis-contribution-missing')
  const judgment = decisionSchema.safeParse(contribution.child.structured)
  if (!judgment.success || judgment.data.purpose !== 'review') throw new Error('synthesis-decision-invalid')
  const decisionRecordId = input.identity.next('decision')
  const decision = requireRecord(
    buildRecord({
      ...recordBase(input.identity, input.scope, decisionRecordId),
      kind: 'decision',
      payload: { originalContributionId: contribution.id, judgment: judgment.data },
    } satisfies Extract<RecordDraft, { kind: 'decision' }>),
    'decision',
  )
  if (!input.canContinue()) return
  await input.publish(decision, 'decision-unconfirmed')
  const history = await input.readHistory()
  const cited = await input.readExternalHistories(history)
  if (!cited.ok) throw new Error(`cited-history-unreadable:${cited.diagnostics.map((item) => item.code).join(',')}`)
  const assessment = validateDecision(
    decision,
    history,
    input.review.canonicalClasses,
    input.review.policy.version === 'evidence-v1' ? input.review.policy.acceptanceRef : null,
    cited.value,
  )
  if (!assessment.admissible) {
    throw new Error(`decision-refused:${assessment.diagnostics.map((item) => item.code).join(',')}`)
  }
  input.onDecisionConfirmed(decision.recordId)
  if (!input.canContinue()) return
  if (input.review.context.subject.kind === 'epic-range') return

  const reviewRecordId = input.identity.next('review')
  const review = requireRecord(
    buildRecord({
      ...recordBase(input.identity, input.scope, reviewRecordId),
      kind: 'review',
      payload: {
        candidateGitSHA: input.review.context.candidateGitSHA,
        input: input.review.context.input,
        inventoryIds: [...input.inventories],
        inputFormat: 'omp-build:review-input/4',
        decisionId: decision.recordId,
      },
    } satisfies Extract<RecordDraft, { kind: 'review' }>),
    'review',
  )
  const latest = await input.readHistory()
  requireFinalContext(latest, input.inventories)
  if (!input.canContinue()) return
  await input.publish(review, 'review-unconfirmed', cited.value)
  return
}
