import type { DecodedHistory } from './history-schema.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Result } from './result.ts'
import { confirmHistoricalReviewInputMatch } from './review-recovery.ts'
import {
  admitReviewInterruption,
  admitReviewReplacementGrant,
  admitReviewReplacementInventory,
} from './review-recovery-admission.ts'
import {
  buildReviewInterruptionRecord,
  buildReviewReplacementGrantRecord,
  buildReviewReplacementInventoryRecord,
} from './review-recovery-records.ts'

type ReviewRoot = Extract<CanonicalRecord, { kind: 'review-attempt' }>
type WorkflowBinding = Extract<CanonicalRecord, { kind: 'workflow-binding' }>
type Mandate = Extract<CanonicalRecord, { kind: 'mandate' }>
type ReviewInterruption = Extract<CanonicalRecord, { kind: 'review-interruption' }>
type ReviewReplacementGrant = Extract<CanonicalRecord, { kind: 'review-replacement-grant' }>

/** Prepare the interruption record after association + I4 digest confirmation. */
export function prepareReviewInterruptionPublication(input: {
  history: DecodedHistory
  root: ReviewRoot
  bindings: readonly WorkflowBinding[]
  mandates: readonly Mandate[]
  histories: readonly DecodedHistory[]
  reconstructedInput: string
  runId: string
}): Result<ReviewInterruption> {
  const association = admitReviewInterruption({
    history: input.history,
    root: input.root,
    bindings: input.bindings,
    mandates: input.mandates,
    histories: input.histories,
  })
  if (!association.ok) return association
  const confirmed = confirmHistoricalReviewInputMatch(input.root, input.reconstructedInput)
  if (!confirmed.ok) return confirmed
  return buildReviewInterruptionRecord({
    root: input.root,
    historicalBinding: association.value.binding,
    runId: input.runId,
  })
}

/** Prepare the one-use grant after interruption admission and fresh binding confirmation. */
export function prepareReviewReplacementGrantPublication(input: {
  history: DecodedHistory
  root: ReviewRoot
  dispositionId: string
  binding: WorkflowBinding
  candidateGitSHA: string
  digest: string
  runId: string
}): Result<ReviewReplacementGrant> {
  const admitted = admitReviewReplacementGrant({
    history: input.history,
    root: input.root,
    dispositionId: input.dispositionId,
    binding: input.binding,
    candidateGitSHA: input.candidateGitSHA,
    digest: input.digest,
  })
  if (!admitted.ok) return admitted
  return buildReviewReplacementGrantRecord({
    root: input.root,
    disposition: admitted.value,
    binding: input.binding,
    candidateGitSHA: input.candidateGitSHA,
    digest: input.digest,
    runId: input.runId,
  })
}

/** Prepare the deterministic linked replacement inventory from the authenticated grant. */
export function prepareReviewReplacementInventoryPublication(input: {
  history: DecodedHistory
  template: ReviewRoot
  binding: WorkflowBinding
  runId: string
}): Result<ReviewRoot> {
  const admitted = admitReviewReplacementInventory({
    history: input.history,
    template: input.template,
    binding: input.binding,
  })
  if (!admitted.ok) return admitted
  return buildReviewReplacementInventoryRecord({
    grant: admitted.value,
    template: input.template,
    runId: input.runId,
  })
}
