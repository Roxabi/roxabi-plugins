import { canonicalValueDigest } from './canonical-value.ts'
import { citedOperationIntegrity } from './delivery-observation-authentication.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope, sameRef } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { Result } from './result.ts'
import type { ContextSuccessionProposal } from './workflow-context-disposition-schema.ts'
import {
  contextHandoffAbsentBindingDigest,
  contextHandoffHistoryDigest,
  contextHandoffPrefixHistories,
} from './workflow-context-handoff-history.ts'
import { bindExternalRef, controlsOf, historyFor, type MandateRecord } from './workflow-control.ts'
import { mandatePayloadSchema } from './workflow-mandate-schema.ts'

type Successor = Pick<MandateRecord, 'repository' | 'target' | 'recordId' | 'payload'>
const refuse = (message: string): Result<never> => ({ ok: false, diagnostics: [diagnostic('unconfirmed', message)] })
const same = (left: unknown, right: unknown) => canonicalValueDigest(left) === canonicalValueDigest(right)

export function authenticateSuccessionAuthority(
  proposal: ContextSuccessionProposal,
  predecessor: MandateRecord,
  successor: Successor,
  histories: readonly DecodedHistory[],
): Result<{
  home: DecodedHistory
  capturedHome: DecodedHistory
  capturedHistories: readonly DecodedHistory[]
  inCut: (ref: ExternalRecordRef) => boolean
}> {
  const scope = proposal.uw
  const home = historyFor(scope, histories)
  if (home === null) return refuse('Context succession history is missing')
  const observation = proposal.reconciliation
  const capturedHistories = contextHandoffPrefixHistories(histories, observation.cuts)
  if (
    capturedHistories === null ||
    observation.historyDigest !== contextHandoffHistoryDigest(capturedHistories) ||
    observation.bindingDigest !== contextHandoffAbsentBindingDigest()
  )
    return refuse('Context succession authority or binding observation changed')
  const capturedHome = historyFor(scope, capturedHistories)
  if (capturedHome === null) return refuse('Context succession captured history is missing')
  const inCut = (ref: ExternalRecordRef): boolean => {
    const cut = observation.cuts.find((item) => equalScope(item.scope, ref.scope))
    const history = historyFor(ref.scope, histories)
    return (
      cut !== undefined &&
      history?.operations
        .slice(0, cut.count)
        .some((operation) => operation.kind === ref.kind && operation.recordId === ref.recordId) === true
    )
  }
  if (
    !inCut(proposal.predecessor) ||
    !inCut(proposal.negative.record) ||
    !inCut(proposal.replacementAccepted.sourceAccepted)
  )
    return refuse('Context succession authority is outside its confirmed history cut')
  const checked = authenticatedProspectiveSelection(proposal, predecessor, successor, histories, home, inCut)
  return checked.ok ? { ok: true, value: { home, capturedHome, capturedHistories, inCut } } : checked
}

function authenticatedProspectiveSelection(
  proposal: ContextSuccessionProposal,
  predecessor: MandateRecord,
  successor: Successor,
  histories: readonly DecodedHistory[],
  home: DecodedHistory,
  inCut: (ref: ExternalRecordRef) => boolean,
): Result<void> {
  const scope = proposal.uw
  if (!mandatePayloadSchema.safeParse(successor.payload).success)
    return refuse('Prospective successor payload is malformed')
  const boundOld = bindExternalRef(proposal.predecessor, home)
  if (
    !boundOld.ok ||
    !same(boundOld.value, predecessor) ||
    citedOperationIntegrity(home, predecessor.recordId) !== null ||
    !equalScope(proposal.predecessor.scope, scope) ||
    !equalScope(proposal.successor.scope, scope) ||
    successor.recordId !== proposal.successor.recordId ||
    !equalScope(successor, scope) ||
    successor.payload.antecedent === null ||
    !sameRef(successor.payload.antecedent, proposal.predecessor) ||
    !same(proposal.predecessorConfig, predecessor.payload.config) ||
    !same(proposal.successorConfig, successor.payload.config) ||
    proposal.successorPayloadDigest !== canonicalValueDigest(successor.payload)
  )
    return refuse('Prospective successor does not bind authenticated authority')
  return authenticateSelectionHistory(proposal, histories, home, inCut)
}

function authenticateSelectionHistory(
  proposal: ContextSuccessionProposal,
  histories: readonly DecodedHistory[],
  home: DecodedHistory,
  inCut: (ref: ExternalRecordRef) => boolean,
): Result<void> {
  const abandonments = controlsOf(home).filter(
    (record) => record.payload.control === 'abandon' && sameRef(record.payload.mandate, proposal.predecessor),
  )
  const abandonment = abandonments[0]
  if (
    abandonments.length !== 1 ||
    abandonment === undefined ||
    citedOperationIntegrity(home, abandonment.recordId) !== null
  )
    return refuse('Context succession lacks its authenticated abandonment')
  if (!inCut({ scope: proposal.uw, kind: 'operator-control', recordId: abandonment.recordId }))
    return refuse('Context succession abandonment is outside its confirmed history cut')
  if (
    histories.some(
      (history) =>
        !history.source.complete ||
        history.operations.some((operation) => operation.authority !== 'foreign' && operation.status !== 'complete'),
    )
  )
    return refuse('Context succession history or effects are incomplete')
  const selections = controlsOf(home).filter(
    (record) =>
      record.payload.control === 'select-successor' && sameRef(record.payload.predecessor, proposal.predecessor),
  )
  if (
    selections.length > 1 ||
    selections.some(
      (record) =>
        record.operationId !== proposal.operationId ||
        record.payload.control !== 'select-successor' ||
        !sameRef(record.payload.successor, proposal.successor),
    )
  )
    return refuse('Context succession has a competing selection')
  return { ok: true, value: undefined }
}
