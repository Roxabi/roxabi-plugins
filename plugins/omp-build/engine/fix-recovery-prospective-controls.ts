import { canonicalValueDigest } from './action-input.ts'
import type { FixRecoveryProposal } from './fix-recovery-control-schema.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope, sameRef } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Result } from './result.ts'

type Control = Extract<CanonicalRecord, { kind: 'fix-recovery' }>
type Operation = DecodedHistory['operations'][number]
const fail = (message: string): Result<never> => ({ ok: false, diagnostics: [diagnostic('unconfirmed', message)] })

function inspectOperation(
  history: DecodedHistory,
  operation: Operation,
  control: Control,
  proposal: FixRecoveryProposal,
): Result<void> {
  if (operation.authority === 'foreign') return { ok: true, value: undefined }
  if (
    operation.record?.kind === 'fix-recovery' &&
    sameRef(operation.record.payload.opened, proposal.opened) &&
    canonicalValueDigest(operation.record) !== canonicalValueDigest(control)
  )
    return fail('Recovery owner has competing controls')
  if (
    equalScope(history.source.scope, proposal.control.scope) &&
    (operation.operationId === proposal.control.operationId || operation.recordId === proposal.control.recordId) &&
    (operation.operationId !== proposal.control.operationId ||
      operation.recordId !== proposal.control.recordId ||
      operation.kind !== 'fix-recovery' ||
      (operation.record !== null && canonicalValueDigest(operation.record) !== canonicalValueDigest(control)))
  )
    return fail('Recovery control reservation collides with another operation')
  return { ok: true, value: undefined }
}

export function inspectProspectiveControls(
  input: { control: Control; histories: readonly DecodedHistory[] },
  proposal: FixRecoveryProposal,
): Result<void> {
  for (const history of input.histories) {
    for (const operation of history.operations) {
      const result = inspectOperation(history, operation, input.control, proposal)
      if (!result.ok) return result
    }
  }
  return { ok: true, value: undefined }
}
