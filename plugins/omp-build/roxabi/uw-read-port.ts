import { createHash } from 'node:crypto'
import type { Gh, GitHubOptions } from '../adapters/github/types.ts'
import {
  assessUwAdmission,
  parseIssueSpecBody,
  readComposedWorkflowHistory,
  readUwGraph,
  resolveAcceptedSpec,
  resolveOwnSpecAuthority,
  resolveSpecIdentityLedger,
  selectApplicableMandate,
} from '../dist/contracts.js'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import type { AcceptedOwnSpecResult, ProposedOwnSpecResult, UwAdmission } from '../engine/uw-admission.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { UwGraphObservation } from '../engine/uw-graph.ts'
import { successionAntecedent } from './feature-succession.ts'
import type { UwRead, UwReadPort } from './uw-contract.ts'
import { readCurrentChildrenProjection } from './uw-current-facts.ts'
import { bindHistoricalProjection, historicalProjection } from './uw-normalization-internal.ts'

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

type HistoryObservation = { ok: true; histories: readonly DecodedHistory[] } | { ok: false; reason: string }

export type InstalledUwReadOptions = {
  cwd: string
  gh?: Gh
  /** Observed authenticated viewer identity, resolved by host composition and used for history attribution. */
  readAuthor?: string
}

export class UwGraphUnavailableError extends Error {
  constructor(readonly diagnostics: readonly UwDiagnostic[]) {
    super(diagnostics.map((entry) => entry.message).join('; '))
  }
}

function diagnostic(uw: Scope, code: string, message: string): UwDiagnostic {
  return { code, message, location: { kind: 'native', uw, connection: 'state' }, related: [] }
}

function refused(uw: Scope, code: string, message: string): UwDiagnostic[] {
  return [diagnostic(uw, code, message)]
}

function readOptions(options: InstalledUwReadOptions): GitHubOptions {
  return {
    cwd: options.cwd,
    gh: options.gh,
    ...(options.readAuthor === undefined ? {} : { readAuthor: options.readAuthor }),
  }
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
): AcceptedOwnSpecResult {
  const own = histories.find(
    (history) => history.source.scope.repository === uw.repository && history.source.scope.target === uw.target,
  )
  if (own === undefined)
    return { status: 'refused', diagnostics: refused(uw, 'history-missing', 'Own UW history is absent') }
  const resolved = contracts.resolveOwnSpecAuthority(
    own,
    histories.filter((history) => history !== own),
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
  input: { uw: Scope; graph: UwGraphObservation; history: HistoryObservation; observedReader?: UwReadPort },
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
    const diagnostics = refused(uw, `history-${history.reason}`, 'Own UW history cannot be read completely')
    return {
      uw,
      parsed,
      graph,
      proposed,
      accepted: { status: 'refused', diagnostics },
      identity: { ok: false, diagnostics },
      admission: admissionUnavailable(diagnostics),
    }
  }
  const accepted = coldAccepted(contracts, uw, history.histories)
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
  })
  const result: UwRead = {
    uw,
    parsed,
    graph,
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
          phase: 'initial-selection',
        })
      : admissionUnavailable(identity.diagnostics),
  }
  bindEligibleHistoricalProjection(contracts, result, own, history.histories)
  return result
}

async function withTransitionAdmission(
  contracts: InstalledUwContracts,
  read: UwRead,
  reader: UwReadPort,
): Promise<UwRead> {
  if (!read.identity.ok) return read
  const currentChildren = await readCurrentChildrenProjection({ uw: read.uw, read, reader })
  const result: UwRead = {
    ...read,
    admission: contracts.assessUwAdmission({
      uw: read.uw,
      graph: read.graph,
      proposed: read.proposed,
      accepted: read.accepted,
      identities: read.identity.value,
      phase: 'delivery-transition',
      currentChildren,
    }),
  }
  const historical = historicalProjection(read)
  if (historical !== undefined) bindHistoricalProjection(result, historical.accepted, historical.historyDigest)
  return result
}

/** Test seam for a loaded facade. */
export function createUwReadPort(contracts: InstalledUwContracts, options: InstalledUwReadOptions): UwReadPort {
  const github = readOptions(options)
  return {
    async readUw(uw): Promise<UwRead> {
      const graph = await contracts.readUwGraph(uw, github)
      const root = graph.nodes.find((node) => node.uw.repository === uw.repository && node.uw.target === uw.target)
      if (root === undefined) {
        const diagnostics =
          graph.status === 'incomplete' && graph.diagnostics.length > 0
            ? graph.diagnostics
            : refused(uw, 'graph-root-missing', `UW graph root ${uw.target} is absent`)
        throw new UwGraphUnavailableError(diagnostics)
      }
      const scopes = [
        ...new Map(graph.nodes.map((node) => [`${node.uw.repository}\0${node.uw.target}`, node.uw])).values(),
      ]
      const composed = await contracts.readComposedWorkflowHistory(scopes, github)
      if (!composed.ok) {
        return assembleUwRead(contracts, {
          uw,
          graph,
          history: { ok: false, reason: composed.reason },
        })
      }
      const reader = createObservedUwReadPort(contracts, { graph, histories: composed.histories })
      return withTransitionAdmission(contracts, await reader.readUw(uw), reader)
    },
  }
}

/** Test seam for an already-observed graph and its composed histories. */
export function createObservedUwReadPort(
  contracts: InstalledUwContracts,
  input: { graph: UwGraphObservation; histories: readonly DecodedHistory[]; history?: HistoryObservation },
): UwReadPort {
  let reader: UwReadPort
  reader = {
    async readUw(uw): Promise<UwRead> {
      return assembleUwRead(contracts, {
        uw,
        graph: input.graph,
        history: input.history ?? { ok: true, histories: input.histories },
        observedReader: reader,
      })
    },
  }
  return reader
}

const installedUwContracts: InstalledUwContracts = {
  assessUwAdmission,
  parseIssueSpecBody,
  readComposedWorkflowHistory,
  readUwGraph,
  resolveAcceptedSpec,
  resolveOwnSpecAuthority,
  resolveSpecIdentityLedger,
  selectApplicableMandate,
}

/** Production factory: statically binds the installed contracts bundle, never repository engine source. */
export function createInstalledUwReadPort(options: InstalledUwReadOptions): UwReadPort {
  return createUwReadPort(installedUwContracts, options)
}

export function createInstalledObservedUwReadPort(input: {
  graph: UwGraphObservation
  histories: readonly DecodedHistory[]
}): UwReadPort {
  return createObservedUwReadPort(installedUwContracts, input)
}
