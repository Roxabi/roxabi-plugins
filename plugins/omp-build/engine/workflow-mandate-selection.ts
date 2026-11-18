import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope, sameRef } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import {
  abandoned,
  bindExternalRef,
  type ControlRecord,
  controlsOf,
  type MandateRecord,
  mandateScope,
  mandatesOf,
  refused,
  successorOf,
} from './workflow-control.ts'
import type { MandateSelection } from './workflow-mandate.ts'

type MandateRefusalSelection = Extract<MandateSelection, { status: 'refused' }>
function noMandateRefusal(history: DecodedHistory): MandateRefusalSelection {
  const claimed = history.operations.some(
    (operation) => operation.kind === 'mandate' || operation.claimedKinds.includes('mandate'),
  )
  return claimed
    ? refused('unconfirmed', [diagnostic('unconfirmed', 'A mandate was claimed but not confirmed')])
    : refused('missing', [diagnostic('missing', 'No mandate record exists')])
}
/** A successor is current only through its unique authenticated selection chain. */
function successorSelectionRefusal(history: DecodedHistory, selected: MandateRecord): MandateRefusalSelection | null {
  const seen = new Set<string>()
  let mandate = selected
  const controls = controlsOf(history)
  while (mandate.payload.antecedent !== null) {
    if (seen.has(mandate.recordId))
      return refused('ambiguous', [diagnostic('ambiguous', 'Mandate successor chain cycles')])
    seen.add(mandate.recordId)
    const predecessor = mandate.payload.antecedent
    if (predecessor.kind !== 'mandate' || !equalScope(predecessor.scope, mandateScope(mandate)))
      return refused('unconfirmed', [diagnostic('unconfirmed', 'Successor antecedent is not a same-UW mandate')])
    const previous = bindExternalRef(predecessor, history)
    if (!previous.ok || previous.value.kind !== 'mandate')
      return refused(
        'unconfirmed',
        previous.ok ? [diagnostic('unconfirmed', 'Successor antecedent is not a mandate')] : previous.diagnostics,
      )
    const issue = selectionControlRefusal(history, mandate, predecessor, controls)
    if (issue !== null) return issue
    mandate = previous.value
  }
  return null
}

function selectionControlRefusal(
  history: DecodedHistory,
  mandate: MandateRecord,
  predecessor: ExternalRecordRef,
  controls: readonly ControlRecord[],
): MandateRefusalSelection | null {
  const claims = controls.filter(
    (record) => record.payload.control === 'select-successor' && sameRef(record.payload.predecessor, predecessor),
  )
  if (claims.length !== 1)
    return refused(claims.length === 0 ? 'unconfirmed' : 'ambiguous', [
      diagnostic(claims.length === 0 ? 'unconfirmed' : 'ambiguous', 'Successor selection is missing or competing'),
    ])
  const control = claims[0]
  if (control === undefined)
    return refused('unconfirmed', [diagnostic('unconfirmed', 'Successor selection is missing or competing')])
  if (
    control.payload.control !== 'select-successor' ||
    !sameRef(control.payload.mandate, predecessor) ||
    !sameRef(control.payload.successor, { scope: mandateScope(mandate), kind: 'mandate', recordId: mandate.recordId })
  )
    return refused('unconfirmed', [diagnostic('unconfirmed', 'Successor selection does not bind its mandate chain')])
  const confirmed = bindExternalRef(
    { scope: mandateScope(mandate), kind: 'operator-control', recordId: control.recordId },
    history,
  )
  return confirmed.ok ? null : refused('unconfirmed', confirmed.diagnostics)
}

export function selectedMandate(history: DecodedHistory): MandateRecord | MandateRefusalSelection {
  const mandates = mandatesOf(history)
  if (mandates.length === 0) return noMandateRefusal(history)
  const active = mandates.filter((mandate) => !abandoned(history, mandate) && successorOf(history, mandate) === null)
  if (active.length === 0) {
    const last = mandates[mandates.length - 1]
    if (last !== undefined && abandoned(history, last))
      return refused('abandoned', [diagnostic('abandoned', `Mandate ${last.recordId} is abandoned`)])
    return refused('revoked', [diagnostic('revoked', 'The mandate was superseded')])
  }
  if (active.length > 1) return refused('ambiguous', [diagnostic('ambiguous', 'More than one mandate is active')])
  const mandate = active[0]
  if (mandate === undefined) return refused('missing', [diagnostic('missing', 'No mandate record exists')])
  if (abandoned(history, mandate))
    return refused('abandoned', [diagnostic('abandoned', `Mandate ${mandate.recordId} is abandoned`)])
  const selectionProblem = successorSelectionRefusal(history, mandate)
  if (selectionProblem !== null) return selectionProblem
  return mandate
}
