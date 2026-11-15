import {
  accounted,
  canonicalValueDigest,
  ciAttributionSchema,
  equalScope,
  failedCheckEvidenceDigest,
  historyFor,
  recordsOf,
  workflowOperationProblem,
} from '../dist/contracts.js'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { Result } from '../engine/result.ts'
import type { ActionReceiptPayload } from '../engine/workflow-receipt-schema.ts'
import type { ActionSubject, RecordInputRef, UwActionRequest } from './uw-action-contract.ts'
import { matchesRequestedSubject } from './uw-action-subject.ts'

function bindingMatchesAttribution(
  bindingRef: RecordInputRef,
  uw: Extract<ActionSubject, { kind: 'uw' }>['uw'],
  mandate: Extract<ActionReceiptPayload, { action: 'attribute-ci'; phase: 'result' }>['mandate'],
  histories: readonly DecodedHistory[],
): boolean {
  const history = historyFor(bindingRef.record.scope, histories)
  if (
    history === null ||
    workflowOperationProblem(history) !== null ||
    bindingRef.record.kind !== 'workflow-binding' ||
    bindingRef.selector !== '/payload'
  )
    return false
  const bindings = recordsOf(history).filter(
    (item) => item.kind === 'workflow-binding' && item.recordId === bindingRef.record.recordId,
  )
  const binding = bindings[0]
  return (
    bindings.length === 1 &&
    binding?.kind === 'workflow-binding' &&
    accounted(history, binding) &&
    canonicalValueDigest(binding.payload) === bindingRef.digest &&
    equalScope(binding.payload.mandate.scope, uw) &&
    mandate.kind === 'mandate' &&
    mandate.recordId === binding.payload.mandate.recordId &&
    equalScope(mandate.scope, binding.payload.mandate.scope)
  )
}

/** A CI result is pre-decision evidence, never authority to dispatch. */
export function priorCiAttribution(
  ref: RecordInputRef,
  request: UwActionRequest,
  subject: ActionSubject,
  histories: readonly DecodedHistory[],
): Result<boolean> {
  const no = { ok: true as const, value: false }
  if (
    request.purpose !== 'correction' ||
    ref.record.kind !== 'action-receipt' ||
    ref.selector !== '/payload' ||
    request.stageSources.some((source) => source.record.kind === 'decision')
  )
    return no
  const scope = request.subject.pullRequest
  if (
    scope === null ||
    !equalScope(scope, ref.record.scope) ||
    request.code.repository !== scope.repository ||
    request.subject.kind !== 'uw' ||
    subject.kind !== 'uw' ||
    subject.pullRequest === null ||
    subject.binding === null ||
    !equalScope(subject.uw, request.subject.uw) ||
    !equalScope(subject.pullRequest, scope)
  )
    return no
  const history = historyFor(scope, histories)
  if (history === null || workflowOperationProblem(history) !== null) return no
  const candidates = recordsOf(history).filter(
    (record) => record.kind === 'action-receipt' && record.recordId === ref.record.recordId,
  )
  const record = candidates[0]
  if (
    candidates.length !== 1 ||
    record?.kind !== 'action-receipt' ||
    !accounted(history, record) ||
    canonicalValueDigest(record.payload) !== ref.digest
  )
    return no
  const payload = record.payload
  if (payload.action !== 'attribute-ci' || payload.phase !== 'result') return no
  const parsed = ciAttributionSchema.safeParse(payload.structured)
  const exact = payload.exactInputs
  if (
    !parsed.success ||
    parsed.data.attribution !== 'change' ||
    exact.candidateGitSHA !== request.code.head ||
    !equalScope(exact.scope, scope) ||
    !/^[0-9a-f]{64}$/.test(exact.evidenceDigest) ||
    failedCheckEvidenceDigest(exact) !== exact.evidenceDigest ||
    payload.inputs.manifest.subject.kind !== 'uw' ||
    payload.inputs.manifest.subject.binding === null ||
    !matchesRequestedSubject(payload.inputs.manifest.subject, subject)
  )
    return no
  return { ok: true, value: bindingMatchesAttribution(subject.binding, subject.uw, payload.mandate, histories) }
}
