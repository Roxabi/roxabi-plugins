import { canonicalValueDigest, historyFor, recordsOf, validateActionInputs } from '../dist/contracts.js'
import type { ActionInputs } from '../engine/action-input-schema.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { ActionReceiptPayload } from '../engine/workflow-receipt-schema.ts'
import type { UwActionRequest } from './uw-action-contract.ts'
import { expandedPlannerMacro, plannerExpansion } from './uw-action-negative-expansion.ts'
import type { ActionFactSource } from './uw-action-observe.ts'
import { authenticate } from './uw-action-observe.ts'
import { validateExpandedWorkflowLive } from './uw-context-negative-live.ts'
import { nonPlanExpansion } from './uw-context-negative-workflow.ts'

type Start = Extract<ActionReceiptPayload, { phase: 'start' }>
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

function validatePlannerSlot(start: Start, request: UwActionRequest, histories: readonly DecodedHistory[]): Check {
  if (start.action !== 'plan' && start.action !== 'plan-review') return { ok: true }
  const planner = plannerExpansion(request, histories)
  if (!planner.ok || planner.value === null || request.subject.kind !== 'uw')
    return { ok: false, reason: 'action-input-missing' }
  const issue = historyFor(request.subject.uw, histories)
  const mandate =
    issue === null
      ? undefined
      : recordsOf(issue).find((record) => record.kind === 'mandate' && record.recordId === start.mandate.recordId)
  if (!issue || !mandate || mandate.kind !== 'mandate') return { ok: false, reason: 'action-input-missing' }
  const macro = expandedPlannerMacro(
    { issue, pullRequest: null, parents: histories.filter((history) => history !== issue) },
    mandate,
    planner.value,
  )
  return macro.ok ? { ok: true } : { ok: false, reason: macro.diagnostics[0]?.code ?? 'action-input-missing' }
}

function validateExpandedBinding(
  start: Start,
  binding: { actionId: string; inputs: ActionInputs },
  histories: readonly DecodedHistory[],
): Check {
  const inputs = binding.inputs
  if (inputs.manifest.expandedContext.length === 0) return { ok: true }
  const references = validateExpandedReferences(inputs, histories)
  if (!references.ok) return references
  const request: UwActionRequest = {
    actionId: binding.actionId,
    purpose: inputs.manifest.purpose,
    subject: inputs.manifest.subject,
    code: inputs.manifest.code,
    stageSources: inputs.stageSources,
    expandedContext: inputs.manifest.expandedContext,
  }
  const origin =
    start.action === 'plan' || start.action === 'plan-review'
      ? plannerExpansion(request, histories)
      : nonPlanExpansion(request, histories)
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
  return validatePlannerSlot(start, request, histories)
}

/** Validate the actual start's semantic slot against every explicit negative lineage before publication. */
export function authorizeExpandedStart(start: Start, histories: readonly DecodedHistory[]): Check {
  const bindings: { actionId: string; inputs: ActionInputs }[] =
    start.action === 'plan-review'
      ? start.slots.flatMap((slot) => (slot.action === undefined ? [] : [slot.action]))
      : [{ actionId: start.actionId, inputs: start.inputs }]
  for (const binding of bindings) {
    const checked = validateExpandedBinding(start, binding, histories)
    if (!checked.ok) return checked
  }
  return { ok: true }
}

/** Re-evaluate the same bound slot on fresh histories after start read-back, before dispatch. */
export function recheckExpandedStart(
  record: Extract<CanonicalRecord, { kind: 'action-receipt' }>,
  histories: readonly DecodedHistory[],
): { ok: true } | { ok: false; reason: string } {
  if (record.payload.phase !== 'start') return { ok: false, reason: 'action-start-unconfirmed' }
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
  const beforeStart = histories.map((history) => ({
    ...history,
    operations: history.operations.filter(
      (operation) =>
        operation.record?.recordId !== record.recordId ||
        operation.record?.repository !== record.repository ||
        operation.record?.target !== record.target,
    ),
  }))
  return authorizeExpandedStart(record.payload, beforeStart)
}

export function hasExpandedStart(start: Start): boolean {
  return (
    start.inputs.manifest.expandedContext.length > 0 ||
    (start.action === 'plan-review' &&
      start.slots.some((slot) => (slot.action?.inputs.manifest.expandedContext.length ?? 0) > 0))
  )
}

export async function validateExpandedStartLive(
  start: Start,
  histories: readonly DecodedHistory[],
  source: ActionFactSource,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (start.action !== 'attribute-ci' || start.inputs.manifest.expandedContext.length === 0) return { ok: true }
  const inputs = start.inputs
  const request: UwActionRequest = {
    actionId: start.actionId,
    purpose: inputs.manifest.purpose,
    subject: inputs.manifest.subject,
    code: inputs.manifest.code,
    stageSources: inputs.stageSources,
    expandedContext: inputs.manifest.expandedContext,
  }
  const origin = nonPlanExpansion(request, histories)
  if (!origin.ok) return { ok: false, reason: origin.diagnostics[0]?.code ?? 'action-input-missing' }
  if (origin.value === null) return { ok: true }
  const live = await validateExpandedWorkflowLive(source, request, origin.value)
  return live.ok ? { ok: true } : { ok: false, reason: live.diagnostics[0]?.code ?? 'action-input-missing' }
}
