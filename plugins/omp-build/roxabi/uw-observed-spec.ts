import type { DecodedHistory } from '../engine/history-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import type { ProposedOwnSpecResult } from '../engine/uw-admission.ts'
import type { UwCompletionObservation } from '../engine/uw-completion-types.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { HistoricalAcceptedSpecContext } from '../engine/workflow-context-succession-inspection.ts'
import type { UwRead } from './uw-contract.ts'
import type { InstalledUwReadOptions } from './uw-read-port.ts'
import type { InstalledUwContracts } from './uw-read-state.ts'
export type ObservedOwnSpecFacts = {
  node: UwRead['graph']['nodes'][number]
  parsed: UwRead['parsed']
  proposed: ProposedOwnSpecResult
  identity: UwRead['identity']
}

type FactualReadContracts = Pick<
  InstalledUwContracts,
  'parseIssueSpecBody' | 'resolveSpecIdentityLedger' | 'createHistoricalAcceptedSpecContext'
>

export function diagnostic(uw: Scope, code: string, message: string): UwDiagnostic {
  return { code, message, location: { kind: 'native', uw, connection: 'state' }, related: [] }
}

export function refused(uw: Scope, code: string, message: string): UwDiagnostic[] {
  return [diagnostic(uw, code, message)]
}

export function observedSpecProjection(
  contracts: Pick<FactualReadContracts, 'parseIssueSpecBody'>,
  uw: Scope,
  node: ObservedOwnSpecFacts['node'],
): Pick<ObservedOwnSpecFacts, 'parsed' | 'proposed'> {
  const parsed = contracts.parseIssueSpecBody({ uw, raw: node.raw })
  const proposed: ProposedOwnSpecResult =
    parsed.status === 'conformant'
      ? { ok: true, snapshot: parsed.snapshot }
      : { ok: false, diagnostics: [...parsed.diagnostics] }
  return { parsed, proposed }
}

function currentHistory(
  uw: Scope,
  histories: readonly DecodedHistory[],
): { ok: true; value: DecodedHistory } | { ok: false; diagnostics: readonly UwDiagnostic[] } {
  let own: DecodedHistory | undefined
  for (const candidate of histories) {
    if (candidate.source.scope.repository !== uw.repository || candidate.source.scope.target !== uw.target) continue
    if (own !== undefined)
      return {
        ok: false,
        diagnostics: refused(uw, 'history-ambiguous', 'Current UW has conflicting history observations'),
      }
    own = candidate
  }
  if (own === undefined || !own.source.complete || own.source.diagnostics.length || own.diagnostics.length)
    return {
      ok: false,
      diagnostics: refused(uw, 'history-incomplete', 'Current framing requires a unique complete UW identity history'),
    }
  return { ok: true, value: own }
}

/** Project framing and identity facts from one complete world, without delivery authority or I/O. */
export function projectObservedOwnSpecFacts(
  contracts: FactualReadContracts,
  input: {
    uw: Scope
    observation: UwCompletionObservation
    assessmentReplay?: InstalledUwReadOptions['assessmentReplay']
    assessmentInspection?: InstalledUwReadOptions['assessmentInspection']
    historical?: HistoricalAcceptedSpecContext
  },
): { ok: true; value: ObservedOwnSpecFacts } | { ok: false; diagnostics: readonly UwDiagnostic[] } {
  const { uw, observation } = input
  if (observation === undefined)
    return {
      ok: false,
      diagnostics: refused(uw, 'observation-missing', 'Current framing requires a complete joint observation'),
    }
  if (observation.status !== 'complete') return { ok: false, diagnostics: observation.diagnostics }
  let node: ObservedOwnSpecFacts['node'] | undefined
  for (const candidate of observation.graph.nodes) {
    if (candidate.uw.repository !== uw.repository || candidate.uw.target !== uw.target) continue
    if (node !== undefined)
      return {
        ok: false,
        diagnostics: refused(uw, 'graph-node-ambiguous', 'Current UW has conflicting native node observations'),
      }
    node = candidate
  }
  if (node === undefined)
    return { ok: false, diagnostics: refused(uw, 'graph-node-missing', 'Current UW native node is absent') }
  const own = currentHistory(uw, observation.histories)
  if (!own.ok) return own
  const prepared =
    input.historical === undefined
      ? contracts.createHistoricalAcceptedSpecContext(observation.histories)
      : { ok: true as const, value: input.historical }
  if (!prepared.ok)
    return {
      ok: false,
      diagnostics: refused(uw, 'history-unconfirmed', 'Historical Spec context cannot be authenticated'),
    }
  const identity = contracts.resolveSpecIdentityLedger({
    uw,
    history: own.value,
    histories: observation.histories,
    accepted: null,
    ...(input.assessmentReplay === undefined ? {} : { assessmentReplay: input.assessmentReplay }),
    ...(input.assessmentInspection === undefined ? {} : { inspection: input.assessmentInspection }),
    historical: prepared.value,
  })
  return { ok: true, value: { node, ...observedSpecProjection(contracts, uw, node), identity } }
}
