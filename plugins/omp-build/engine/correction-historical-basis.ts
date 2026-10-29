import { canonicalValueDigest, validateActionInputs } from './action-input.ts'
import type { ActionInputs, ActionSubject, RecordInputRef } from './action-input-schema.ts'
import { resolveCorrectionRequestBasis } from './correction-request-basis.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Result } from './result.ts'
import { accounted, resolvedOutputValid } from './review-context-authentication.ts'
import { validateDecisionBindings } from './review-decision.ts'
import { historyFor, recordsOf, workflowOperationProblem } from './workflow-control.ts'

type Contribution = Extract<CanonicalRecord, { kind: 'contribution' }>
type Decision = Extract<CanonicalRecord, { kind: 'decision' }>
export type HistoricalCorrectionBasis = {
  inputs: ActionInputs
  requestRef: RecordInputRef
  decisionRef: RecordInputRef
  originalCandidate: string
  expectedRemoteHead: string
  branch: string
  base: string
  bindingRef: RecordInputRef | null
  lineage: CanonicalRecord[]
}
const failure = (): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic('record-unreadable', 'Correction historical basis is missing or inconsistent')],
})
const ref = (record: CanonicalRecord): RecordInputRef => ({
  source: 'record',
  record: {
    scope: { repository: record.repository, target: record.target },
    kind: record.kind,
    recordId: record.recordId,
  },
  selector: '/payload',
  digest: canonicalValueDigest(record.payload),
})

function correctionDecision(
  history: DecodedHistory,
  records: CanonicalRecord[],
  source: Contribution,
  inventory: Extract<CanonicalRecord, { kind: 'review-attempt' }>,
  inputs: ActionInputs,
): Result<{ decision: Decision; decisionRef: RecordInputRef }> {
  const decisions = inputs.stageSources.filter(
    (item) => item.record.kind === 'decision' && item.selector === '/payload',
  )
  const decisionRef = decisions[0]
  if (decisions.length !== 1 || decisionRef === undefined) return failure()
  const matching = records.filter(
    (record) => record.kind === 'decision' && record.recordId === decisionRef.record.recordId,
  )
  const decision = matching[0]
  if (
    matching.length !== 1 ||
    decision?.kind !== 'decision' ||
    !accounted(history, decision) ||
    canonicalValueDigest(ref(decision)) !== canonicalValueDigest(decisionRef) ||
    !inventory.inputs.includes(decision.recordId) ||
    !source.inputs.includes(decision.recordId) ||
    !validateDecisionBindings(decision, history).admissible
  )
    return failure()
  return { ok: true, value: { decision, decisionRef } }
}

function correctionBinding(
  subject: ActionSubject,
  histories: readonly DecodedHistory[],
  basis: { branch: string; base: string },
): Result<{ bindingRef: RecordInputRef | null; bindingRecord: CanonicalRecord | null }> {
  const bindingRef = subject.kind === 'uw' ? subject.binding : null
  if (subject.kind === 'uw' && bindingRef === null) return failure()
  if (bindingRef === null) return { ok: true, value: { bindingRef, bindingRecord: null } }
  const history = historyFor(bindingRef.record.scope, histories)
  if (history === null) return failure()
  const bindings = recordsOf(history).filter(
    (record) => record.kind === 'workflow-binding' && record.recordId === bindingRef.record.recordId,
  )
  const binding = bindings[0]
  if (
    bindings.length !== 1 ||
    binding?.kind !== 'workflow-binding' ||
    !accounted(history, binding) ||
    canonicalValueDigest(ref(binding)) !== canonicalValueDigest(bindingRef) ||
    binding.payload.branch !== basis.branch ||
    binding.payload.base !== basis.base
  )
    return failure()
  return { ok: true, value: { bindingRef, bindingRecord: binding } }
}

function correctionInventory(
  history: DecodedHistory,
  records: CanonicalRecord[],
  source: Contribution,
): Result<{
  inventory: Extract<CanonicalRecord, { kind: 'review-attempt' }>
  requestId: string
  inputs: ActionInputs
}> {
  const inventories = records.filter(
    (record) => record.kind === 'review-attempt' && record.recordId === source.payload.inventoryId,
  )
  const inventory = inventories[0]
  if (
    inventories.length !== 1 ||
    inventory?.kind !== 'review-attempt' ||
    inventory.payload.stage !== 'initial' ||
    inventory.payload.purpose !== 'correction' ||
    !accounted(history, inventory) ||
    !source.inputs.includes(inventory.recordId)
  )
    return failure()
  const requestId = inventory.payload.requestId
  const slots = inventory.payload.slots.filter((slot) => slot.slotId === source.payload.host.slotId)
  const slot = slots[0]
  if (
    slots.length !== 1 ||
    slot?.action === undefined ||
    !resolvedOutputValid(source, slot, inventory.recordId, slot.action.inputs) ||
    !validateActionInputs(slot.action.inputs).ok ||
    slot.action.inputs.manifest.purpose !== 'correction' ||
    slot.action.inputs.fingerprint !== inventory.payload.actionInputDigest ||
    slot.action.inputs.manifest.code.head !== inventory.payload.candidateGitSHA
  )
    return failure()
  return { ok: true, value: { inventory, requestId, inputs: slot.action.inputs } }
}

function historicalSubjectMatches(
  inputs: ActionInputs,
  source: Contribution,
  expectedSubject: ActionSubject | undefined,
): boolean {
  const subject = inputs.manifest.subject
  if (expectedSubject !== undefined && canonicalValueDigest(subject) !== canonicalValueDigest(expectedSubject))
    return false
  return (
    subject.pullRequest !== null &&
    subject.pullRequest.repository === source.repository &&
    subject.pullRequest.target === source.target &&
    inputs.manifest.code.repository === source.repository
  )
}

/** Immutable host-record evidence only; never authorizes execution or reconstructs a live route. */
export function resolveHistoricalCorrectionBasis(input: {
  contribution: Contribution
  histories: readonly DecodedHistory[]
  expectedSubject?: ActionSubject
}): Result<HistoricalCorrectionBasis> {
  const source = input.contribution
  const scope = { repository: source.repository, target: source.target }
  const history = historyFor(scope, input.histories)
  if (
    history === null ||
    workflowOperationProblem(history) !== null ||
    !accounted(history, source) ||
    source.payload.inventoryId === null
  )
    return failure()
  const records = recordsOf(history)
  const selectedInventory = correctionInventory(history, records, source)
  if (!selectedInventory.ok) return selectedInventory
  const { inventory, requestId, inputs } = selectedInventory.value
  const requests = records.filter((r) => r.kind === 'fix-request' && r.recordId === requestId)
  const fix = requests[0]
  if (
    requests.length !== 1 ||
    fix?.kind !== 'fix-request' ||
    !accounted(history, fix) ||
    !inventory.inputs.includes(fix.recordId) ||
    !source.inputs.includes(fix.recordId)
  )
    return failure()
  const selectedDecision = correctionDecision(history, records, source, inventory, inputs)
  if (!selectedDecision.ok) return selectedDecision
  const { decision, decisionRef } = selectedDecision.value
  const resolved = resolveCorrectionRequestBasis(history, fix, decision)
  if (!resolved.ok) return resolved
  const basis = resolved.value
  const subject = inputs.manifest.subject
  if (!historicalSubjectMatches(inputs, source, input.expectedSubject)) return failure()
  const selectedBinding = correctionBinding(subject, input.histories, basis)
  if (!selectedBinding.ok) return selectedBinding
  const { bindingRef, bindingRecord } = selectedBinding.value
  const original = records.find(
    (r) => r.kind === 'contribution' && r.recordId === decision.payload.originalContributionId,
  )
  if (original?.kind !== 'contribution' || original.payload.inventoryId === null) return failure()
  const origin = records.find((r) => r.kind === 'review-attempt' && r.recordId === original.payload.inventoryId)
  if (origin?.kind !== 'review-attempt') return failure()
  const ids = new Set([
    fix.payload.requestContributionId,
    original.recordId,
    origin.recordId,
    fix.payload.existingReviewId ?? origin.payload.rootAttemptId,
  ])
  const lineage = [
    source,
    inventory,
    fix,
    decision,
    ...records.filter((record) => ids.has(record.recordId)),
    ...(bindingRecord === null ? [] : [bindingRecord]),
  ]
  return {
    ok: true,
    value: { inputs, requestRef: ref(fix), decisionRef, ...basis, bindingRef, lineage },
  }
}
