import type { DecodedHistory } from '../engine/history-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import type { ReviewClassCatalogues } from '../engine/review-class-catalogue.ts'
import type { AcceptedOwnSpecResult, ProposedOwnSpecResult, UwAdmission } from '../engine/uw-admission.ts'
import type { UwCompletionAssessment, UwCompletionObservation } from '../engine/uw-completion-types.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { UwGraphObservation } from '../engine/uw-graph.ts'
import type { UwRead, UwReadPort } from './uw-contract.ts'
import { bindEligibleHistoricalProjection } from './uw-read-historical-projection.ts'
import type { InstalledUwReadOptions } from './uw-read-port.ts'

type InstalledUwContracts = Pick<
  typeof import('../dist/contracts.js'),
  | 'assessUwAdmission'
  | 'readFramingMembership'
  | 'parseIssueSpecBody'
  | 'assessUwCompletion'
  | 'readUwCompletionObservation'
  | 'readComposedWorkflowHistory'
  | 'readUwGraph'
  | 'resolveOwnSpecAuthority'
  | 'resolveAcceptedSpec'
  | 'selectApplicableMandate'
  | 'resolveSpecIdentityLedger'
>

type HistoryObservation =
  | { ok: true; histories: readonly DecodedHistory[] }
  | {
      ok: false
      reason: string
      histories: readonly DecodedHistory[]
      diagnostics?: readonly { code: string; message: string }[]
    }

export type ObservedOwnSpecFacts = {
  node: UwRead['graph']['nodes'][number]
  parsed: UwRead['parsed']
  proposed: ProposedOwnSpecResult
  identity: UwRead['identity']
}

type FactualReadContracts = Pick<InstalledUwContracts, 'parseIssueSpecBody' | 'resolveSpecIdentityLedger'>

function diagnostic(uw: Scope, code: string, message: string): UwDiagnostic {
  return { code, message, location: { kind: 'native', uw, connection: 'state' }, related: [] }
}

function refused(uw: Scope, code: string, message: string): UwDiagnostic[] {
  return [diagnostic(uw, code, message)]
}

function observedSpecProjection(
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
  const identity = contracts.resolveSpecIdentityLedger({
    uw,
    history: own.value,
    histories: observation.histories,
    accepted: null,
    ...(input.assessmentReplay === undefined ? {} : { assessmentReplay: input.assessmentReplay }),
  })
  return { ok: true, value: { node, ...observedSpecProjection(contracts, uw, node), identity } }
}

function admissionUnavailable(diagnostics: readonly UwDiagnostic[], aggregate: UwAdmission['aggregate']): UwAdmission {
  const all = aggregate?.status === 'held' ? [...diagnostics, ...aggregate.diagnostics] : diagnostics
  return {
    framed: { ok: false, diagnostics: all },
    deliverable: { ok: false, diagnostics: all },
    applicability: 'unresolved',
    aggregate,
  }
}

function coldAccepted(
  contracts: InstalledUwContracts,
  uw: Scope,
  histories: readonly DecodedHistory[],
  catalogues: ReviewClassCatalogues,
  observation: UwCompletionObservation,
  assessmentReplay?: { uw: Scope; actionId: string; fingerprint: string },
): AcceptedOwnSpecResult {
  if (observation.status !== 'complete') return { status: 'refused', diagnostics: observation.diagnostics }
  const own = histories.find(
    (history) => history.source.scope.repository === uw.repository && history.source.scope.target === uw.target,
  )
  if (own === undefined)
    return { status: 'refused', diagnostics: refused(uw, 'history-missing', 'Own UW history is absent') }
  const resolved = contracts.resolveOwnSpecAuthority(
    own,
    histories.filter((history) => history !== own),
    { histories, catalogues, observation },
    undefined,
    assessmentReplay,
  )
  if (!resolved.ok) {
    const hasOwnMandateClaim = own.operations.some(
      (operation) =>
        operation.authority !== 'foreign' &&
        (operation.kind === 'mandate' || operation.claimedKinds.includes('mandate')),
    )
    if (!hasOwnMandateClaim) return { status: 'absent' }
    const summary = resolved.diagnostics.map((entry) => `${entry.code}: ${entry.message}`).join('; ')
    return {
      status: 'refused',
      diagnostics: refused(uw, 'accepted-unavailable', summary || 'Own accepted Spec cannot be reconstructed'),
    }
  }
  return { status: 'accepted', value: resolved.value.accepted }
}

function assembleUwRead(
  contracts: InstalledUwContracts,
  input: {
    uw: Scope
    graph: UwGraphObservation
    history: HistoryObservation
    catalogues: ReviewClassCatalogues
    observation: UwCompletionObservation
    causalObservation: UwRead['causalObservation']
    completion: UwCompletionAssessment
    observedReader?: UwReadPort
    assessmentReplay?: InstalledUwReadOptions['assessmentReplay']
  },
): UwRead {
  const { uw, graph, history } = input
  const root = graph.nodes.find((node) => node.uw.repository === uw.repository && node.uw.target === uw.target)
  if (root === undefined) throw new Error(`UW graph root is missing: ${uw.target}`)
  // The requested node is the native observation authority for its body, title, labels, state and relations.
  const { parsed, proposed } = observedSpecProjection(contracts, uw, root)
  if (!history.ok) {
    const diagnostics = history.diagnostics?.length
      ? history.diagnostics.map((entry) => diagnostic(uw, entry.code, entry.message))
      : refused(uw, `history-${history.reason}`, 'Own UW history cannot be read completely')
    return {
      uw,
      parsed,
      graph,
      observation: input.observation,
      completion: input.completion,
      histories: history.histories,
      catalogues: input.catalogues,
      causalObservation: input.causalObservation,
      proposed,
      accepted: { status: 'refused', diagnostics },
      identity: { ok: false, diagnostics },
      admission: admissionUnavailable(
        diagnostics,
        contracts.readFramingMembership({
          uw,
          graph,
          histories: history.histories,
          accepted: { status: 'refused', diagnostics },
        }),
      ),
    }
  }
  const accepted = coldAccepted(
    contracts,
    uw,
    history.histories,
    input.catalogues,
    input.observation,
    input.assessmentReplay,
  )
  const own = history.histories.find(
    (entry) => entry.source.scope.repository === uw.repository && entry.source.scope.target === uw.target,
  )
  if (own === undefined) {
    const diagnostics = refused(uw, 'history-missing', 'Own UW history is absent')
    return {
      uw,
      parsed,
      graph,
      observation: input.observation,
      completion: input.completion,
      proposed,
      histories: history.histories,
      catalogues: input.catalogues,
      causalObservation: input.causalObservation,
      accepted,
      identity: { ok: false, diagnostics },
      admission: admissionUnavailable(
        diagnostics,
        contracts.readFramingMembership({ uw, graph, histories: history.histories, accepted }),
      ),
    }
  }
  const identity = contracts.resolveSpecIdentityLedger({
    uw,
    history: own,
    histories: history.histories,
    accepted: accepted.status === 'accepted' ? accepted.value : null,
    ...(input.assessmentReplay === undefined ? {} : { assessmentReplay: input.assessmentReplay }),
  })
  const result: UwRead = {
    uw,
    parsed,
    observation: input.observation,
    completion: input.completion,
    graph,
    histories: history.histories,
    catalogues: input.catalogues,
    causalObservation: input.causalObservation,
    proposed,
    accepted,
    identity,
    ...(input.observedReader === undefined ? {} : { observedReader: input.observedReader }),
    admission: identity.ok
      ? contracts.assessUwAdmission({
          uw,
          graph,
          proposed,
          accepted,
          identities: identity.value,
          histories: history.histories,
          catalogues: input.catalogues,
          completion: input.completion,
          phase: 'initial-selection',
        })
      : admissionUnavailable(
          identity.diagnostics,
          contracts.readFramingMembership({ uw, graph, histories: history.histories, accepted }),
        ),
  }
  bindEligibleHistoricalProjection(contracts, result, own, history.histories, input.assessmentReplay)
  return result
}

export type { HistoryObservation, InstalledUwContracts }
export { assembleUwRead, refused }
