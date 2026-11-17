import type { DecodedHistory } from '../engine/history-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import type { ReviewClassCatalogues } from '../engine/review-class-catalogue.ts'
import type { AcceptedOwnSpecResult, UwAdmission } from '../engine/uw-admission.ts'
import type { UwCompletionAssessment, UwCompletionObservation } from '../engine/uw-completion-types.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { UwGraphObservation } from '../engine/uw-graph.ts'
import type { HistoricalAcceptedSpecContext } from '../engine/workflow-context-succession-inspection.ts'
import type { AcceptedSpecInspection, AssessmentReplayContext } from '../engine/workflow-spec-authentication.ts'
import type { UwRead, UwReadPort } from './uw-contract.ts'
import { diagnostic, observedSpecProjection, refused } from './uw-observed-spec.ts'
import type { InstalledUwReadOptions } from './uw-read-port.ts'

export type { ObservedOwnSpecFacts } from './uw-observed-spec.ts'
export { projectObservedOwnSpecFacts } from './uw-observed-spec.ts'

type InstalledUwContracts = Pick<
  typeof import('../dist/contracts.js'),
  | 'assessUwAdmission'
  | 'createHistoricalAcceptedSpecContext'
  | 'historicalAcceptedSpecOwnedHistories'
  | 'discoverFixRecovery'
  | 'projectRecoveryHistories'
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

function admissionUnavailable(diagnostics: readonly UwDiagnostic[], aggregate: UwAdmission['aggregate']): UwAdmission {
  const all = aggregate.status === 'held' ? [...diagnostics, ...aggregate.diagnostics] : diagnostics
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
  assessmentReplay?: AssessmentReplayContext,
  assessmentInspection?: AcceptedSpecInspection,
  historical?: HistoricalAcceptedSpecContext,
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
    assessmentInspection,
    historical,
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
    assessmentInspection?: InstalledUwReadOptions['assessmentInspection']
    historical?: HistoricalAcceptedSpecContext
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
      fixRecovery: contracts.discoverFixRecovery({ uw, histories: history.histories, graph }),
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
    input.assessmentInspection,
    input.historical,
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
      fixRecovery: contracts.discoverFixRecovery({ uw, histories: history.histories, graph }),
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
    ...(input.assessmentInspection === undefined ? {} : { inspection: input.assessmentInspection }),
    historical: input.historical,
  })
  const result: UwRead = {
    uw,
    parsed,
    observation: input.observation,
    ...(input.historical === undefined ? {} : { historical: input.historical }),
    completion: input.completion,
    graph,
    histories: history.histories,
    catalogues: input.catalogues,
    causalObservation: input.causalObservation,
    proposed,
    accepted,
    identity,
    fixRecovery: contracts.discoverFixRecovery({ uw, histories: history.histories, graph }),
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
  return result
}

export type { HistoryObservation, InstalledUwContracts }
export { assembleUwRead, refused }
