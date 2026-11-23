import { canonicalValueDigest, recordsOf, validateActionInputs } from '../dist/contracts.js'
import type { ActionInputs } from '../engine/action-input-schema.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { ActionReceiptPayload } from '../engine/workflow-receipt-schema.ts'
import type { UwActionRequest } from './uw-action-contract.ts'
import { authenticate } from './uw-action-observe.ts'
import { nonPlanExpansion } from './uw-context-negative-workflow.ts'

type Start = Extract<ActionReceiptPayload, { phase: 'start'; action: 'assess-spec' }>
const same = (left: unknown, right: unknown) => canonicalValueDigest(left) === canonicalValueDigest(right)

type Check = { ok: true } | { ok: false; reason: string }

function validateExpandedReferences(inputs: ActionInputs, histories: readonly DecodedHistory[]): Check {
  if (!validateActionInputs(inputs).ok) return { ok: false, reason: 'action-inputs-unconfirmed' }
  for (const ref of inputs.manifest.expandedContext) {
    if (ref.source !== 'record' || ref.record.kind !== 'action-receipt' || ref.selector !== '/payload') continue
    const found = histories
      .flatMap(recordsOf)
      .filter(
        (record) =>
          record.kind === 'action-receipt' &&
          record.recordId === ref.record.recordId &&
          record.repository === ref.record.scope.repository &&
          record.target === ref.record.scope.target,
      )
    if (
      found.length !== 1 ||
      found[0] === undefined ||
      !authenticate(found[0], histories).ok ||
      canonicalValueDigest(found[0].payload) !== ref.digest
    )
      return { ok: false, reason: 'record-unreadable' }
  }
  return { ok: true }
}

export function authorizeExpandedStart(start: Start, histories: readonly DecodedHistory[]): Check {
  const inputs = start.inputs
  const references = validateExpandedReferences(inputs, histories)
  if (!references.ok) return references
  const request: UwActionRequest = {
    actionId: start.actionId,
    purpose: inputs.manifest.purpose,
    subject: inputs.manifest.subject,
    code: inputs.manifest.code,
    stageSources: inputs.stageSources,
    expandedContext: inputs.manifest.expandedContext,
    ...(inputs.manifest.operands === undefined ? {} : { operands: inputs.manifest.operands }),
  }
  const origin = nonPlanExpansion(request, histories)
  if (!origin.ok) return { ok: false, reason: origin.diagnostics[0]?.code ?? 'action-input-missing' }
  if (origin.value === null) return { ok: true }
  const previous = origin.value.previous
  const { expandedContext: _old, ...oldAuthority } = previous.manifest
  const { expandedContext: _new, ...newAuthority } = inputs.manifest
  if (
    origin.value.slot.action !== start.action ||
    !same(origin.value.slot.exact, start.exactInputs) ||
    !same(origin.value.mandate, start.mandate) ||
    previous.fingerprint === inputs.fingerprint ||
    !same(oldAuthority, newAuthority) ||
    !same(previous.stageSources, inputs.stageSources)
  )
    return { ok: false, reason: 'review-input-changed' }
  return { ok: true }
}

/** Re-evaluate the same bound slot on fresh histories after start read-back, before dispatch. */
export function recheckExpandedStart(
  record: Extract<CanonicalRecord, { kind: 'action-receipt' }>,
  histories: readonly DecodedHistory[],
): { ok: true } | { ok: false; reason: string } {
  if (record.payload.phase !== 'start' || record.payload.action !== 'assess-spec')
    return { ok: false, reason: 'action-start-unconfirmed' }
  const observed = histories.flatMap((history) =>
    history.operations
      .filter(
        (operation) =>
          operation.status === 'complete' &&
          operation.record?.kind === 'action-receipt' &&
          operation.record.recordId === record.recordId &&
          operation.record.repository === record.repository &&
          operation.record.target === record.target,
      )
      .map((operation) => operation.record),
  )
  if (observed.length !== 1 || !same(observed[0], record)) return { ok: false, reason: 'action-start-unconfirmed' }
  const withoutStart = (history: DecodedHistory): DecodedHistory => ({
    ...history,
    operations: history.operations.filter(
      (operation) =>
        operation.record?.recordId !== record.recordId ||
        operation.record?.repository !== record.repository ||
        operation.record?.target !== record.target,
    ),
  })
  const beforeStart = histories.map(withoutStart)
  return authorizeExpandedStart(record.payload, beforeStart)
}
