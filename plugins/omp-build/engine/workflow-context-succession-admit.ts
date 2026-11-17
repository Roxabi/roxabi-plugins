import { canonicalValueDigest } from './canonical-value.ts'
import { citedOperationIntegrity } from './delivery-observation-authentication.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope, sameRef } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { Result } from './result.ts'
import { type ContextSuccessionAdmission, prepareContextSuccession } from './workflow-context-succession.ts'
import { contextSuccessionProposal } from './workflow-context-succession-confirmation.ts'
import type { HistoricalAcceptedSpecContext } from './workflow-context-succession-inspection.ts'
import { bindExternalRef, type ControlRecord, controlsOf, historyFor } from './workflow-control.ts'

const refuse = (message: string): Result<never> => ({ ok: false, diagnostics: [diagnostic('unconfirmed', message)] })
const same = (left: unknown, right: unknown) => canonicalValueDigest(left) === canonicalValueDigest(right)
/** Validate the authenticated historical authority and exact negative chain, without modifying its outcome. */
export function admitContextSuccession(
  control: ControlRecord,
  histories: readonly DecodedHistory[],
  historical?: HistoricalAcceptedSpecContext,
): Result<ContextSuccessionAdmission> {
  const payload = control.payload
  if (payload.control !== 'select-successor' || payload.contextDisposition === undefined)
    return refuse('Context succession disposition is absent')
  const historyCheck = authenticateCompleteHistory(histories)
  if (!historyCheck.ok) return historyCheck
  const scope = { repository: control.repository, target: control.target }
  const home = historyFor(scope, histories)
  if (
    home === null ||
    !sameRef(payload.mandate, payload.predecessor) ||
    !equalScope(payload.predecessor.scope, scope) ||
    !equalScope(payload.successor.scope, scope) ||
    !equalScope(payload.contextDisposition.negative.record.scope, scope)
  )
    return refuse('Context succession authority is not scoped to one UW')
  const controlBound = bindExternalRef({ scope, kind: 'operator-control', recordId: control.recordId }, home)
  if (
    !controlBound.ok ||
    !same(controlBound.value, control) ||
    citedOperationIntegrity(home, control.recordId) !== null
  )
    return refuse('Context succession control is not authenticated')
  const oldResult = bindExternalRef(payload.predecessor, home)
  const newResult = bindExternalRef(payload.successor, home)
  if (!oldResult.ok || oldResult.value.kind !== 'mandate' || !newResult.ok || newResult.value.kind !== 'mandate')
    return refuse('Context succession mandates are unavailable')
  const predecessor = oldResult.value
  const successor = newResult.value
  if (
    citedOperationIntegrity(home, predecessor.recordId) !== null ||
    citedOperationIntegrity(home, successor.recordId) !== null ||
    successor.payload.antecedent === null ||
    !sameRef(successor.payload.antecedent, payload.predecessor)
  )
    return refuse('Context succession mandate chain is not authenticated')
  const claims = authenticateSelectionClaims(home, control, payload.predecessor)
  if (!claims.ok) return claims
  const proposal = contextSuccessionProposal(control, successor, predecessor)
  if (!proposal.ok) return refuse('Context succession confirmation is not bound')
  const prepared = prepareContextSuccession(proposal.value, predecessor, successor, histories, historical)
  if (!prepared.ok) return prepared
  return { ok: true, value: { control, predecessor, successor, ...prepared.value } }
}

function authenticateCompleteHistory(histories: readonly DecodedHistory[]): Result<void> {
  if (histories.length === 0 || histories.some((history) => !history.source.complete))
    return refuse('Context succession history is incomplete')
  if (
    histories.some((history) =>
      history.operations.some((operation) => operation.authority !== 'foreign' && operation.status !== 'complete'),
    )
  )
    return refuse('Context succession contains incomplete authority or effect history')
  return { ok: true, value: undefined }
}

function authenticateSelectionClaims(
  home: DecodedHistory,
  control: ControlRecord,
  predecessor: ExternalRecordRef,
): Result<void> {
  const claims = home.operations.filter(
    (operation) =>
      operation.authority !== 'foreign' &&
      operation.record?.kind === 'operator-control' &&
      operation.record.payload.control === 'select-successor' &&
      sameRef(operation.record.payload.predecessor, predecessor),
  )
  if (
    claims.length === 0 ||
    claims.some(
      (claim) => claim.status !== 'complete' || claim.authority !== 'accounted' || claim.recordId !== control.recordId,
    )
  )
    return refuse('Context succession has competing or incomplete selections')
  const abandonments = controlsOf(home).filter(
    (record) => record.payload.control === 'abandon' && sameRef(record.payload.mandate, predecessor),
  )
  if (
    abandonments.length !== 1 ||
    abandonments[0] === undefined ||
    citedOperationIntegrity(home, abandonments[0].recordId) !== null
  )
    return refuse('Context succession lacks its unique authenticated abandonment')
  return { ok: true, value: undefined }
}
