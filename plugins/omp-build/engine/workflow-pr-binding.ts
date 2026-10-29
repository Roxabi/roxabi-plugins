import { canonicalValueDigest } from './action-input.ts'
import type { ActionInputs } from './action-input-schema.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope, fail, sameRef } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { Diagnostic, Scope } from './record-values.ts'
import type { Result } from './result.ts'
import {
  bindExternalRef,
  historyFor,
  type MandateRecord,
  type WorkflowBindingRecord,
  workflowOperationProblem,
} from './workflow-control.ts'
import { selectWorkflowBindingCandidate } from './workflow-pr-binding-chain.ts'

export function confirmedAccountedMandate(history: DecodedHistory, ref: ExternalRecordRef): MandateRecord | null {
  const matches = history.operations.filter(
    (operation) =>
      operation.status === 'complete' &&
      operation.authority === 'accounted' &&
      operation.record?.kind === 'mandate' &&
      operation.record.recordId === ref.recordId &&
      equalScope({ repository: operation.record.repository, target: operation.record.target }, ref.scope),
  )
  const bodies = matches.map((operation) => JSON.stringify(operation.record))
  if (matches.length === 0 || new Set(bodies).size !== 1) return null
  const record = matches[0]?.record
  return record?.kind === 'mandate' ? record : null
}

export type WorkflowBindingSelection =
  | {
      status: 'bound'
      binding: WorkflowBindingRecord
      mandate: ExternalRecordRef
      mandateRecord: MandateRecord
    }
  | { status: 'absent' }
  | { status: 'incomplete' | 'conflicting' | 'incompatible-format'; diagnostics: Diagnostic[] }

export function selectWorkflowBinding(input: {
  pullRequest: Scope
  histories: readonly DecodedHistory[]
  native: { branch: string; base: string }
}): WorkflowBindingSelection {
  const chained = selectWorkflowBindingCandidate(input)
  if (chained.status !== 'bound') return chained
  const home = historyFor(chained.binding.payload.mandate.scope, input.histories)
  if (home === null || !home.source.complete) {
    return {
      status: 'incomplete',
      diagnostics: [diagnostic('incomplete', 'Binding mandate history is missing or incomplete')],
    }
  }
  const problem = workflowOperationProblem(home)
  if (problem === 'incompatible-format') {
    const formatDiagnostic = home.diagnostics.find((entry) => entry.code === problem)
    return {
      status: problem,
      diagnostics: [formatDiagnostic ?? diagnostic(problem, 'Binding mandate uses an incompatible format')],
    }
  }
  const mandateRecord = confirmedAccountedMandate(home, chained.binding.payload.mandate)
  if (mandateRecord === null) {
    return {
      status: 'incomplete',
      diagnostics: [diagnostic('incomplete', 'Binding mandate record is not confirmed')],
    }
  }
  return {
    status: 'bound',
    binding: chained.binding,
    mandate: chained.binding.payload.mandate,
    mandateRecord,
  }
}

function unboundReviewMandate(inputs: ActionInputs, histories: readonly DecodedHistory[]): Result<MandateRecord> {
  const { subject, acceptedSources, purpose, code } = inputs.manifest
  if (subject.kind !== 'uw' || subject.pullRequest !== null || subject.binding !== null || purpose !== 'review')
    return fail([diagnostic('unconfirmed', 'Unbound mandate is only valid for a UW review')])
  if (code.repository !== subject.uw.repository)
    return fail([diagnostic('mismatch', 'UW review code repository does not match its subject')])
  const pins = acceptedSources.filter(
    (source) => source.record.kind === 'mandate' && equalScope(source.record.scope, subject.uw),
  )
  const pin = pins[0]
  if (pins.length !== 1 || pin?.selector !== '/payload')
    return fail([diagnostic('unconfirmed', 'UW review requires exactly one pinned execution mandate')])
  const home = historyFor(subject.uw, histories)
  if (home === null) return fail([diagnostic('missing-history', 'Mandate history is absent')])
  const resolved = bindExternalRef(pin.record, home)
  if (!resolved.ok) return resolved
  if (
    resolved.value.kind !== 'mandate' ||
    !equalScope(resolved.value.payload.ownSpec.uw, subject.uw) ||
    canonicalValueDigest(resolved.value.payload) !== pin.digest
  )
    return fail([diagnostic('unconfirmed', 'UW review mandate pin does not match its authenticated record')])
  return { ok: true, value: resolved.value }
}

/** Authenticate the execution mandate pinned by historical action inputs. */
export function resolveManifestMandate(
  inputs: ActionInputs,
  histories: readonly DecodedHistory[],
): Result<MandateRecord> {
  const { subject, spec, acceptedSources } = inputs.manifest
  if (subject.kind !== 'uw' || spec.kind !== 'accepted' || !equalScope(spec.effective.own.uw, subject.uw))
    return fail([diagnostic('unconfirmed', 'Action inputs do not identify an accepted UW Spec')])
  if (subject.pullRequest === null) return unboundReviewMandate(inputs, histories)
  if (
    subject.binding === null ||
    !equalScope(subject.binding.record.scope, subject.pullRequest) ||
    subject.binding.record.kind !== 'workflow-binding' ||
    subject.binding.selector !== '/payload'
  )
    return fail([diagnostic('unconfirmed', 'Action inputs lack a pinned PR workflow binding')])
  const bindingHistory = historyFor(subject.binding.record.scope, histories)
  if (bindingHistory === null) return fail([diagnostic('missing-history', 'Binding history is absent')])
  const bound = bindExternalRef(subject.binding.record, bindingHistory)
  if (!bound.ok) return bound
  if (
    bound.value.kind !== 'workflow-binding' ||
    canonicalValueDigest(bound.value.payload) !== subject.binding.digest ||
    bound.value.payload.mandate.kind !== 'mandate' ||
    !equalScope(bound.value.payload.mandate.scope, subject.uw)
  )
    return fail([diagnostic('unconfirmed', 'Pinned workflow binding does not identify the action mandate')])
  const mandateRef = bound.value.payload.mandate
  const mandateHistory = historyFor(mandateRef.scope, histories)
  if (mandateHistory === null) return fail([diagnostic('missing-history', 'Mandate history is absent')])
  const resolved = bindExternalRef(mandateRef, mandateHistory)
  if (!resolved.ok) return resolved
  if (
    resolved.value.kind !== 'mandate' ||
    !acceptedSources.some(
      (source) =>
        sameRef(source.record, mandateRef) &&
        source.selector === '/payload' &&
        source.digest === canonicalValueDigest(resolved.value.payload),
    )
  )
    return fail([diagnostic('unconfirmed', 'Execution mandate is not pinned in accepted sources')])
  return { ok: true, value: resolved.value }
}
