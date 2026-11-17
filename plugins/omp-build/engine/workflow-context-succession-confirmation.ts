import { canonicalValueDigest } from './canonical-value.ts'
import { diagnostic } from './record-diagnostics.ts'
import type { Result } from './result.ts'
import type { ContextSuccessionProposal } from './workflow-context-disposition-schema.ts'
import type { ControlRecord, MandateRecord } from './workflow-control.ts'

/** Reconstruct exactly what the operator confirmed, without treating the confirmation as delivery admission. */
export function contextSuccessionProposal(
  control: ControlRecord,
  successor: MandateRecord,
  predecessor: MandateRecord,
): Result<ContextSuccessionProposal> {
  const payload = control.payload
  const refuse = (): Result<never> => ({
    ok: false,
    diagnostics: [diagnostic('unconfirmed', 'Context succession confirmation does not bind this successor')],
  })
  if (
    payload.control !== 'select-successor' ||
    payload.contextDisposition === undefined ||
    payload.predecessor.kind !== 'mandate' ||
    payload.successor.kind !== 'mandate' ||
    payload.predecessor.recordId !== predecessor.recordId ||
    payload.predecessor.scope.repository !== predecessor.repository ||
    payload.predecessor.scope.target !== predecessor.target ||
    payload.successor.recordId !== successor.recordId ||
    payload.successor.scope.repository !== successor.repository ||
    payload.successor.scope.target !== successor.target
  )
    return refuse()
  const disposition = payload.contextDisposition
  const proposal: ContextSuccessionProposal = {
    format: 'omp-build-context-succession/1',
    uw: { repository: control.repository, target: control.target },
    operationId: control.operationId,
    controlId: payload.controlId,
    predecessor: { ...payload.predecessor, kind: 'mandate' },
    predecessorConfig: predecessor.payload.config,
    successorConfig: successor.payload.config,
    successor: { ...payload.successor, kind: 'mandate' },
    successorPayloadDigest: canonicalValueDigest(successor.payload),
    negative: disposition.negative,
    replacementAccepted: disposition.replacementAccepted,
    reconciliation: disposition.reconciliation,
  }
  if (
    disposition.confirmation.operationId !== control.operationId ||
    disposition.confirmation.proposalDigest !== disposition.proposalDigest ||
    canonicalValueDigest(proposal) !== disposition.proposalDigest
  )
    return refuse()
  return { ok: true, value: proposal }
}
