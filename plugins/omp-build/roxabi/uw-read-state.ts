import { createHash } from 'node:crypto'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import type { ReviewClassCatalogues } from '../engine/review-class-catalogue.ts'
import type { AcceptedOwnSpecResult, ProposedOwnSpecResult, UwAdmission } from '../engine/uw-admission.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { UwGraphObservation } from '../engine/uw-graph.ts'
import { successionAntecedent } from './feature-succession.ts'
import type { UwRead, UwReadPort } from './uw-contract.ts'
import { bindHistoricalProjection } from './uw-normalization-internal.ts'
import type { InstalledUwReadOptions } from './uw-read-port.ts'

type InstalledUwContracts = Pick<
  typeof import('../dist/contracts.js'),
  | 'assessUwAdmission'
  | 'parseIssueSpecBody'
  | 'readComposedWorkflowHistory'
  | 'readUwGraph'
  | 'resolveOwnSpecAuthority'
  | 'resolveAcceptedSpec'
  | 'selectApplicableMandate'
  | 'resolveSpecIdentityLedger'
>

type HistoryObservation =
  | { ok: true; histories: readonly DecodedHistory[] }
  | { ok: false; reason: string; diagnostics?: readonly { code: string; message: string }[] }

function diagnostic(uw: Scope, code: string, message: string): UwDiagnostic {
  return { code, message, location: { kind: 'native', uw, connection: 'state' }, related: [] }
}

function refused(uw: Scope, code: string, message: string): UwDiagnostic[] {
  return [diagnostic(uw, code, message)]
}

function admissionUnavailable(diagnostics: readonly UwDiagnostic[]): UwAdmission {
  return {
    framed: { ok: false, diagnostics },
    deliverable: { ok: false, diagnostics },
    applicability: 'own-only',
  }
}

function coldAccepted(
  contracts: InstalledUwContracts,
  uw: Scope,
  histories: readonly DecodedHistory[],
  catalogues: ReviewClassCatalogues,
  assessmentReplay?: { actionId: string; fingerprint: string },
): AcceptedOwnSpecResult {
  const own = histories.find(
    (history) => history.source.scope.repository === uw.repository && history.source.scope.target === uw.target,
  )
  if (own === undefined)
    return { status: 'refused', diagnostics: refused(uw, 'history-missing', 'Own UW history is absent') }
  const resolved = contracts.resolveOwnSpecAuthority(
    own,
    histories.filter((history) => history !== own),
    { histories, catalogues },
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

function bindEligibleHistoricalProjection(
  contracts: InstalledUwContracts,
  result: UwRead,
  own: DecodedHistory,
  histories: readonly DecodedHistory[],
): void {
  const selection = contracts.selectApplicableMandate(
    own,
    histories.filter((entry) => entry !== own),
    { histories, catalogues: result.catalogues },
  )
  if (
    result.accepted.status !== 'refused' ||
    selection.status !== 'refused' ||
    (selection.reason !== 'abandoned' && selection.reason !== 'revoked')
  )
    return
  const antecedent = successionAntecedent(own)
  if ('reason' in antecedent || antecedent.mandate.payload.format !== 'omp-build-mandate/3') return
  const historical = contracts.resolveAcceptedSpec(antecedent.mandate, histories)
  if (historical.ok)
    bindHistoricalProjection(
      result,
      historical.spec,
      createHash('sha256').update(JSON.stringify(histories)).digest('hex'),
    )
}

function assembleUwRead(
  contracts: InstalledUwContracts,
  input: {
    uw: Scope
    graph: UwGraphObservation
    history: HistoryObservation
    catalogues: ReviewClassCatalogues
    observedReader?: UwReadPort
    assessmentReplay?: InstalledUwReadOptions['assessmentReplay']
  },
): UwRead {
  const { uw, graph, history } = input
  const root = graph.nodes.find((node) => node.uw.repository === uw.repository && node.uw.target === uw.target)
  if (root === undefined) throw new Error(`UW graph root is missing: ${uw.target}`)
  // The requested node is the native observation authority for its body, title, labels, state and relations.
  const parsed = contracts.parseIssueSpecBody({ uw, raw: root.raw })
  const proposed: ProposedOwnSpecResult =
    parsed.status === 'conformant'
      ? { ok: true, snapshot: parsed.snapshot }
      : { ok: false, diagnostics: [...parsed.diagnostics] }
  if (!history.ok) {
    const diagnostics = history.diagnostics?.length
      ? history.diagnostics.map((entry) => diagnostic(uw, entry.code, entry.message))
      : refused(uw, `history-${history.reason}`, 'Own UW history cannot be read completely')
    return {
      uw,
      parsed,
      graph,
      histories: [],
      catalogues: input.catalogues,
      causalObservation: { status: 'unavailable' },
      proposed,
      accepted: { status: 'refused', diagnostics },
      identity: { ok: false, diagnostics },
      admission: admissionUnavailable(diagnostics),
    }
  }
  const replay =
    input.assessmentReplay?.uw.repository === uw.repository && input.assessmentReplay.uw.target === uw.target
      ? input.assessmentReplay
      : undefined
  const accepted = coldAccepted(contracts, uw, history.histories, input.catalogues, replay)
  const own = history.histories.find(
    (entry) => entry.source.scope.repository === uw.repository && entry.source.scope.target === uw.target,
  )
  if (own === undefined) {
    const diagnostics = refused(uw, 'history-missing', 'Own UW history is absent')
    return {
      uw,
      parsed,
      graph,
      proposed,
      histories: history.histories,
      catalogues: input.catalogues,
      causalObservation: { status: 'unavailable' },
      accepted,
      identity: { ok: false, diagnostics },
      admission: admissionUnavailable(diagnostics),
    }
  }
  const identity = contracts.resolveSpecIdentityLedger({
    uw,
    history: own,
    histories: history.histories,
    accepted: accepted.status === 'accepted' ? accepted.value : null,
    ...(replay === undefined ? {} : { assessmentReplay: replay }),
  })
  const result: UwRead = {
    uw,
    parsed,
    graph,
    histories: history.histories,
    catalogues: input.catalogues,
    causalObservation: { status: 'unavailable' },
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
          phase: 'initial-selection',
        })
      : admissionUnavailable(identity.diagnostics),
  }
  bindEligibleHistoricalProjection(contracts, result, own, history.histories)
  return result
}

export type { HistoryObservation, InstalledUwContracts }
export { assembleUwRead, refused }
