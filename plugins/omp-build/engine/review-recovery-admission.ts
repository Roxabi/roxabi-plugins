import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope, fail } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Result } from './result.ts'
import {
  type HistoricalReviewAssociation,
  interruptiblePullRequestRoot,
  proveHistoricalReviewAssociation,
  readReviewRecovery,
} from './review-recovery.ts'
import { isInitialPullRequestReviewInventory } from './review-schema.ts'

type ReviewRoot = Extract<CanonicalRecord, { kind: 'review-attempt' }>
type ReviewInterruption = Extract<CanonicalRecord, { kind: 'review-interruption' }>
type ReviewReplacementGrant = Extract<CanonicalRecord, { kind: 'review-replacement-grant' }>
type WorkflowBinding = Extract<CanonicalRecord, { kind: 'workflow-binding' }>

function completeRecords(history: DecodedHistory): CanonicalRecord[] {
  return history.operations.flatMap((operation) =>
    operation.status === 'complete' && operation.record !== null ? [operation.record] : [],
  )
}

function isHistoricalRoot(record: CanonicalRecord): record is ReviewRoot {
  return (
    record.kind === 'review-attempt' &&
    isInitialPullRequestReviewInventory(record.payload) &&
    record.recordId === record.payload.rootAttemptId &&
    record.payload.replacement === undefined
  )
}

function sameRecord(left: CanonicalRecord, right: CanonicalRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** Admit publishing a review-interruption for one authenticated unfinished historical root. */
export function admitReviewInterruption(input: {
  history: DecodedHistory
  root: ReviewRoot
  bindings: readonly WorkflowBinding[]
  mandates: readonly Extract<CanonicalRecord, { kind: 'mandate' }>[]
  histories: readonly DecodedHistory[]
}): Result<HistoricalReviewAssociation> {
  if (!isHistoricalRoot(input.root))
    return fail([diagnostic('unbound', 'Only an original initial pull-request review inventory can be interrupted')])
  const recovery = readReviewRecovery(input.history)
  if (!recovery.ok) return recovery
  const root = interruptiblePullRequestRoot(input.history)
  if (root === null || !sameRecord(root, input.root))
    return fail([
      diagnostic('unbound', 'The supplied root is not the sole authenticated interruptible historical root'),
    ])
  return proveHistoricalReviewAssociation({
    root: input.root,
    bindings: input.bindings,
    mandates: input.mandates,
    histories: input.histories,
  })
}

/** Admit one deterministic one-use replacement grant under a fresh exact binding. */
export function admitReviewReplacementGrant(input: {
  history: DecodedHistory
  root: ReviewRoot
  dispositionId: string
  binding: WorkflowBinding
  candidateGitSHA: string
  digest: string
}): Result<ReviewInterruption> {
  if (!isHistoricalRoot(input.root))
    return fail([diagnostic('unbound', 'A replacement grant cannot target a replacement or non-root inventory')])
  const recovery = readReviewRecovery(input.history)
  if (!recovery.ok) return recovery
  if (recovery.value.normalProgression !== 'stopped' || recovery.value.replacementGrant !== null)
    return fail([diagnostic('conflict', 'Replacement grant requires a stopped terminal with no existing grant')])
  const records = completeRecords(input.history)
  const root = records.find(
    (record): record is ReviewRoot => record.kind === 'review-attempt' && record.recordId === input.root.recordId,
  )
  const disposition = records.find(
    (record): record is ReviewInterruption =>
      record.kind === 'review-interruption' &&
      record.recordId === input.dispositionId &&
      record.payload.rootAttemptId === input.root.recordId,
  )
  const binding = records.find(
    (record): record is WorkflowBinding =>
      record.kind === 'workflow-binding' && record.recordId === input.binding.recordId,
  )
  if (
    root === undefined ||
    !sameRecord(root, input.root) ||
    disposition === undefined ||
    binding === undefined ||
    !sameRecord(binding, input.binding) ||
    !equalScope(binding, input.root) ||
    !/^[0-9a-f]{40}$/.test(input.candidateGitSHA) ||
    !/^[0-9a-f]{64}$/.test(input.digest)
  )
    return fail([
      diagnostic('unbound', 'Replacement grant requires the current root, terminal, binding, candidate, and digest'),
    ])
  return { ok: true, value: disposition }
}

/** Admit the deterministic linked replacement inventory against the one unconsumed grant. */
export function admitReviewReplacementInventory(input: {
  history: DecodedHistory
  template: ReviewRoot
  binding: WorkflowBinding
}): Result<ReviewReplacementGrant> {
  const recovery = readReviewRecovery(input.history)
  if (!recovery.ok) return recovery
  if (recovery.value.normalProgression !== 'stopped' || recovery.value.replacementGrant === null)
    return fail([diagnostic('unbound', 'Replacement inventory requires one unconsumed replacement grant')])
  const grant = recovery.value.replacementGrant
  const records = completeRecords(input.history)
  const root = records.find(
    (record): record is ReviewRoot =>
      record.kind === 'review-attempt' && record.recordId === grant.payload.rootAttemptId && isHistoricalRoot(record),
  )
  const binding = records.find(
    (record): record is WorkflowBinding =>
      record.kind === 'workflow-binding' && record.recordId === input.binding.recordId,
  )
  if (!isInitialPullRequestReviewInventory(input.template.payload))
    return fail([diagnostic('conflict', 'Replacement inventory template must be an initial pull-request review')])
  const template = input.template.payload
  if (
    root === undefined ||
    binding === undefined ||
    !sameRecord(binding, input.binding) ||
    !equalScope(root, input.template) ||
    !equalScope(binding, root) ||
    !equalScope(grant.payload.binding.scope, binding) ||
    template.replacement !== undefined ||
    template.candidateGitSHA !== grant.payload.candidateGitSHA ||
    template.input !== grant.payload.input
  )
    return fail([
      diagnostic('conflict', 'Replacement inventory must exactly match its grant candidate, input, scope, and binding'),
    ])
  return { ok: true, value: grant }
}
