import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope, fail } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { Diagnostic } from './record-values.ts'
import type { Result } from './result.ts'
import {
  abandoned,
  bindExternalRef,
  type ControlRecord,
  controlsOf,
  type MandateRecord,
  mandateScope,
  mandatesOf,
  successorClaim,
} from './workflow-control.ts'
import { historyRefusal } from './workflow-mandate-history.ts'

export type TerminalMandate = Readonly<{
  mandate: MandateRecord
  ref: ExternalRecordRef & { kind: 'mandate' }
}>

type TerminalLineage = {
  bound: Map<string, MandateRecord>
  successors: Map<string, string>
  tip: MandateRecord | null
}

/** Authenticate the unique abandoned tip of this UW's whole lineage, never active authority. */
export function terminalMandate(history: DecodedHistory): Result<TerminalMandate> {
  const refusedHistory = historyRefusal(history)
  if (refusedHistory !== null) return fail(refusedHistory.evidence)
  const lineage: TerminalLineage = { bound: new Map(), successors: new Map(), tip: null }
  for (const mandate of mandatesOf(history)) {
    const problem = terminalMemberProblem(history, mandate, lineage)
    if (problem !== null) return fail(problem)
  }
  const tip = lineage.tip
  if (tip === null) return fail([diagnostic('successor-unconfirmed', 'No unique terminal mandate tip exists')])
  for (const control of controlsOf(history)) {
    const problem = terminalControlProblem(history, control, lineage.bound)
    if (problem !== null) return fail(problem)
  }
  const problem = terminalLineageProblem(history, lineage, tip)
  if (problem !== null) return fail(problem)
  return {
    ok: true,
    value: { mandate: tip, ref: { scope: history.source.scope, recordId: tip.recordId, kind: 'mandate' } },
  }
}

function terminalMemberProblem(
  history: DecodedHistory,
  mandate: MandateRecord,
  lineage: TerminalLineage,
): Diagnostic[] | null {
  const ref = { scope: history.source.scope, recordId: mandate.recordId, kind: 'mandate' as const }
  const authenticated = bindExternalRef(ref, history)
  if (!authenticated.ok) return authenticated.diagnostics
  if (authenticated.value.kind !== 'mandate' || !equalScope(mandateScope(authenticated.value), ref.scope))
    return [diagnostic('successor-unconfirmed', 'Antecedent mandate does not belong to this UW')]
  lineage.bound.set(mandate.recordId, authenticated.value)
  const claim = successorClaim(history, ref)
  if (claim.status !== 'none' && claim.status !== 'next') return claim.diagnostics
  if (claim.status === 'next') {
    if (claim.ref.kind !== 'mandate' || !equalScope(claim.ref.scope, history.source.scope))
      return [diagnostic('successor-unconfirmed', 'Successor claim leaves this UW')]
    lineage.successors.set(mandate.recordId, claim.ref.recordId)
  } else {
    if (lineage.tip !== null) return [diagnostic('ambiguous', 'More than one mandate lineage tip exists')]
    lineage.tip = authenticated.value
  }
  return null
}

function terminalControlProblem(
  history: DecodedHistory,
  control: ControlRecord,
  bound: ReadonlyMap<string, MandateRecord>,
): Diagnostic[] | null {
  const target =
    control.payload.control === 'abandon'
      ? control.payload.mandate
      : control.payload.control === 'select-successor'
        ? control.payload.predecessor
        : null
  if (target === null) return null
  if (target.kind !== 'mandate' || !equalScope(target.scope, history.source.scope) || !bound.has(target.recordId))
    return [diagnostic('successor-unconfirmed', 'Terminal control does not name this mandate lineage')]
  const authenticated = bindExternalRef(
    { scope: history.source.scope, recordId: control.recordId, kind: 'operator-control' },
    history,
  )
  if (!authenticated.ok) return authenticated.diagnostics
  if (
    authenticated.value.repository !== history.source.scope.repository ||
    authenticated.value.target !== history.source.scope.target
  )
    return [diagnostic('successor-unconfirmed', 'Terminal control does not belong to this UW')]
  return null
}

function terminalLineageProblem(
  history: DecodedHistory,
  lineage: { bound: ReadonlyMap<string, MandateRecord>; successors: ReadonlyMap<string, string> },
  tip: MandateRecord,
): Diagnostic[] | null {
  if (!abandoned(history, tip))
    return [diagnostic('successor-not-terminal', 'Terminal mandate tip must be explicitly abandoned')]
  const visited = new Set<string>()
  let current = tip
  for (;;) {
    if (visited.has(current.recordId)) return [diagnostic('cycle', 'Mandate succession contains a cycle')]
    visited.add(current.recordId)
    const antecedent = current.payload.antecedent
    if (antecedent === null) break
    if (antecedent.kind !== 'mandate' || !equalScope(antecedent.scope, history.source.scope))
      return [diagnostic('successor-unconfirmed', 'Antecedent leaves this UW')]
    const previous = lineage.bound.get(antecedent.recordId)
    if (previous === undefined || lineage.successors.get(previous.recordId) !== current.recordId)
      return [diagnostic('successor-unconfirmed', 'Antecedent and successor controls do not confirm one chain')]
    current = previous
  }
  if (visited.size !== lineage.bound.size)
    return [diagnostic('ambiguous', 'Mandate history contains an orphan or competing lineage')]
  return null
}
