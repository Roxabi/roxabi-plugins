import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope, fail } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Result } from './result.ts'
import { type InitialPullRequestReviewInventory, isInitialPullRequestReviewInventory } from './review-schema.ts'
import { resolveAcceptedSpec } from './workflow-accepted-spec.ts'
import type { AcceptedSpec } from './workflow-accepted-spec-types.ts'
import type { MandateRecord } from './workflow-control.ts'

type ReviewRoot = Extract<CanonicalRecord, { kind: 'review-attempt' }>
type WorkflowBinding = Extract<CanonicalRecord, { kind: 'workflow-binding' }>
type Mandate = Extract<CanonicalRecord, { kind: 'mandate' }>
type PullRequestReviewRoot = ReviewRoot & { payload: InitialPullRequestReviewInventory }
type HistoricalReviewAssociationInput = {
  root: ReviewRoot
  bindings: readonly WorkflowBinding[]
  mandates: readonly Mandate[]
  histories: readonly DecodedHistory[]
}

export type HistoricalReviewAssociation = {
  binding: WorkflowBinding
  mandate: MandateRecord
  accepted: AcceptedSpec
}

function samePullRequestScope(
  left: { repository: string; target: string },
  right: { repository: string; target: string },
): boolean {
  return equalScope(left, right)
}

function isInitialPullRequestRoot(record: CanonicalRecord): record is PullRequestReviewRoot {
  return (
    record.kind === 'review-attempt' &&
    isInitialPullRequestReviewInventory(record.payload) &&
    record.recordId === record.payload.rootAttemptId &&
    record.payload.replacement === undefined
  )
}

/** Enumerate structurally authenticated B/M pairs before host I4 reconstruction selects B1. */
export function historicalReviewAssociations(
  input: HistoricalReviewAssociationInput,
): Result<readonly HistoricalReviewAssociation[]> {
  const root = input.root
  if (!isInitialPullRequestRoot(root) || root.payload.input === null || root.payload.inputSnapshot === null)
    return fail([
      diagnostic('unbound', 'Interrupted root lacks a persisted review input and input snapshot for reconstruction'),
    ])
  const rootScope = { repository: root.repository, target: root.target }
  const candidates: HistoricalReviewAssociation[] = []
  for (const binding of input.bindings) {
    if (!samePullRequestScope(binding, rootScope)) continue
    const mandateRef = binding.payload.mandate
    const mandates = input.mandates.filter(
      (mandate): mandate is MandateRecord =>
        mandate.recordId === mandateRef.recordId &&
        mandate.kind === 'mandate' &&
        samePullRequestScope(mandate, mandateRef.scope) &&
        samePullRequestScope(mandate, rootScope),
    )
    if (mandates.length !== 1) continue
    const accepted = resolveAcceptedSpec(mandates[0], input.histories)
    if (accepted.ok) candidates.push({ binding, mandate: mandates[0], accepted: accepted.spec })
  }
  return candidates.length === 0
    ? fail([diagnostic('unbound', 'No historical workflow binding and mandate can reconstruct the review input')])
    : { ok: true, value: candidates }
}

/** Prove a unique historical binding/mandate can reconstruct the interrupted root's accepted Spec. */
export function proveHistoricalReviewAssociation(
  input: HistoricalReviewAssociationInput,
): Result<HistoricalReviewAssociation> {
  const candidates = historicalReviewAssociations(input)
  if (!candidates.ok) return candidates
  if (candidates.value.length > 1)
    return fail([
      diagnostic(
        'ambiguous',
        'Multiple historical binding/mandate pairs require I4 reconstruction to identify the original review input',
      ),
    ])
  return { ok: true, value: candidates.value[0] }
}

/** Require the reconstructed digest to equal the interrupted root's persisted input (I4). */
export function confirmHistoricalReviewInputMatch(root: ReviewRoot, reconstructedInput: string): Result<ReviewRoot> {
  if (root.payload.input === null)
    return fail([diagnostic('unbound', 'Interrupted root has no persisted review input to confirm')])
  if (root.payload.input !== reconstructedInput)
    return fail([
      diagnostic(
        'unbound',
        'Reconstructed historical review input does not match the interrupted root persisted input',
      ),
    ])
  return { ok: true, value: root }
}
