import type { Gh, GitHubOptions } from '../adapters/github/types.ts'
import {
  assessUwAdmission,
  assessUwCompletion,
  discoverFixRecovery,
  parseIssueSpecBody,
  projectRecoveryHistories,
  readComposedWorkflowHistory,
  readFramingMembership,
  readUwCompletionObservation,
  readUwGraph,
  resolveAcceptedSpec,
  resolveOwnSpecAuthority,
  resolveSpecIdentityLedger,
  selectApplicableMandate,
} from '../dist/contracts.js'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import type { UwCompletionObservation } from '../engine/uw-completion-types.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import { defaultGh } from './feature-engine.ts'
import { withRoxabiGitHubPolicy } from './github-policy.ts'
import { loadReviewClassCatalogues } from './review-class-catalogues.ts'
import type { CreatedUwRead, UwRead, UwReadPort } from './uw-contract.ts'
import { assembleUwRead, type HistoryObservation, type InstalledUwContracts, refused } from './uw-read-state.ts'
import { withTransitionAdmission } from './uw-read-transition.ts'

export type InstalledUwReadOptions = {
  cwd: string
  gh?: Gh
  /** Observed authenticated viewer identity, resolved by host composition and used for history attribution. */
  readAuthor?: string
  assessmentReplay?: { uw: Scope; actionId: string; fingerprint: string }
}

export class UwGraphUnavailableError extends Error {
  constructor(readonly diagnostics: readonly UwDiagnostic[]) {
    super(diagnostics.map((entry) => entry.message).join('; '))
  }
}

function readOptions(options: InstalledUwReadOptions): GitHubOptions {
  return withRoxabiGitHubPolicy({
    cwd: options.cwd,
    gh: options.gh,
    ...(options.readAuthor === undefined ? {} : { readAuthor: options.readAuthor }),
  })
}

/** Test seam for a loaded facade. */
export function createUwReadPort(contracts: InstalledUwContracts, options: InstalledUwReadOptions): UwReadPort {
  return {
    async readUw(uw): Promise<UwRead> {
      const observation = await readUwObservation(contracts, uw, options)
      const reader = createObservedUwReadPort(contracts, { observation, assessmentReplay: options.assessmentReplay })
      const read = await reader.readUw(uw)
      return withTransitionAdmission(contracts, read)
    },
  }
}

async function readUwObservation(
  contracts: InstalledUwContracts,
  uw: Scope,
  options: InstalledUwReadOptions,
): Promise<UwCompletionObservation> {
  const observation = await contracts.readUwCompletionObservation(uw, readOptions(options), (histories) =>
    loadReviewClassCatalogues({ histories, cwd: options.cwd, gh: options.gh ?? defaultGh() }),
  )
  if (!observation.graph.nodes.some((node) => node.uw.repository === uw.repository && node.uw.target === uw.target)) {
    const diagnostics =
      observation.status === 'incomplete'
        ? observation.diagnostics
        : refused(uw, 'graph-root-missing', `UW graph root ${uw.target} is absent`)
    throw new UwGraphUnavailableError(diagnostics)
  }
  return observation
}

/** A fresh observation, not an admission or completion decision. */
export async function readInstalledUwObservation(uw: Scope, options: InstalledUwReadOptions) {
  return projectObservation(installedUwContracts, await readUwObservation(installedUwContracts, uw, options))
}

function projectObservation(
  contracts: InstalledUwContracts,
  observation: UwCompletionObservation,
): UwCompletionObservation {
  const projected = contracts.projectRecoveryHistories(observation.histories)
  if (projected.ok) return { ...observation, histories: projected.value }
  const refusal: UwDiagnostic = {
    code: 'recovery-projection-refused',
    message: projected.diagnostics.map((entry) => entry.message).join('; '),
    location: { kind: 'native', uw: observation.root, connection: 'state' },
    related: [],
  }
  const diagnostics: [UwDiagnostic, ...UwDiagnostic[]] = [refusal]
  if (observation.status === 'incomplete') diagnostics.unshift(...observation.diagnostics)
  return { ...observation, status: 'incomplete', diagnostics }
}

function projectHistory(
  contracts: InstalledUwContracts,
  original: UwCompletionObservation,
  observation: UwCompletionObservation,
  supplied?: HistoryObservation,
): HistoryObservation {
  if (supplied === undefined || supplied.histories === original.histories) {
    if (observation.status === 'complete' && (supplied === undefined || supplied.ok))
      return { ok: true, histories: observation.histories }
    return {
      ok: false,
      reason: 'incomplete',
      histories: observation.histories,
      ...(observation.status === 'incomplete'
        ? { diagnostics: observation.diagnostics }
        : supplied?.ok === false && supplied.diagnostics !== undefined
          ? { diagnostics: supplied.diagnostics }
          : {}),
    }
  }
  const projection = contracts.projectRecoveryHistories(supplied.histories)
  return projection.ok
    ? { ...supplied, histories: projection.value }
    : { ok: false, reason: 'incomplete', histories: supplied.histories, diagnostics: projection.diagnostics }
}

/** Test seam for an already-observed graph and its composed histories. */
export function createObservedUwReadPort(
  contracts: InstalledUwContracts,
  input: {
    observation: UwCompletionObservation
    history?: HistoryObservation
    assessmentReplay?: InstalledUwReadOptions['assessmentReplay']
  },
): UwReadPort {
  const observation = projectObservation(contracts, input.observation)
  const completion = contracts.assessUwCompletion(observation)
  const history = projectHistory(contracts, input.observation, observation, input.history)
  const causalObservation: UwRead['causalObservation'] =
    observation.status === 'complete' && history.ok && history.histories === observation.histories
      ? { status: 'complete', histories: observation.histories, catalogues: observation.catalogues }
      : { status: 'unavailable' }
  let reader: UwReadPort
  reader = {
    async readUw(uw): Promise<UwRead> {
      return assembleUwRead(contracts, {
        uw,
        graph: observation.graph,
        history,
        catalogues: observation.catalogues,
        observation,
        causalObservation,
        completion,
        observedReader: reader,
        assessmentReplay: input.assessmentReplay,
      })
    },
  }
  return reader
}

const installedUwContracts: InstalledUwContracts = {
  assessUwAdmission,
  discoverFixRecovery,
  projectRecoveryHistories,
  readFramingMembership,
  assessUwCompletion,
  readUwCompletionObservation,
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

function requiresFramingClosure(uw: Scope, ownHistory: DecodedHistory): boolean {
  if (
    ownHistory.operations.some(
      (operation) =>
        operation.authority !== 'foreign' &&
        operation.status !== 'complete' &&
        (operation.kind === 'framing-receipt' ||
          operation.claimedKinds.includes('framing-receipt') ||
          operation.kind === 'spec-identity' ||
          operation.claimedKinds.includes('spec-identity')),
    )
  )
    throw new UwGraphUnavailableError(
      refused(uw, 'history-incomplete', 'Created UW framing or identity claim is incomplete'),
    )
  return ownHistory.operations.some((operation) => {
    if (operation.authority === 'foreign') return false
    // A damaged trusted claim must never make an aggregate look like a singleton.
    if (operation.kind === 'framing-receipt' || operation.claimedKinds.includes('framing-receipt')) return true
    const record = operation.record
    return record?.kind === 'spec-identity' && record.payload.format === 'omp-build-spec-identity/2'
  })
}

function createdFacts(
  uw: Scope,
  currentGraph: CreatedUwRead['graph'],
  histories: CreatedUwRead['histories'],
): CreatedUwRead {
  const root = currentGraph.nodes.find((node) => node.uw.repository === uw.repository && node.uw.target === uw.target)
  if (root === undefined)
    throw new UwGraphUnavailableError(refused(uw, 'graph-root-missing', `UW graph root ${uw.target} is absent`))
  const parsed = installedUwContracts.parseIssueSpecBody({ uw, raw: root.raw })
  const proposed =
    parsed.status === 'conformant'
      ? { ok: true as const, snapshot: parsed.snapshot }
      : { ok: false as const, diagnostics: [...parsed.diagnostics] }
  const own = histories.find(
    (entry) => entry.source.scope.repository === uw.repository && entry.source.scope.target === uw.target,
  )
  if (own === undefined)
    throw new UwGraphUnavailableError(refused(uw, 'history-missing', 'Created UW identity history is absent'))
  const identity = installedUwContracts.resolveSpecIdentityLedger({
    uw,
    history: own,
    histories,
    accepted: null,
  })
  return { uw, parsed, proposed, identity, histories, graph: currentGraph }
}

/** Creation readback proves only native framing and the created issue's own identity ledger. */
export async function readCreatedUw(uw: Scope, options: InstalledUwReadOptions): Promise<CreatedUwRead> {
  const github = readOptions(options)
  const graph = await installedUwContracts.readUwGraph(uw, github)
  if (graph.status !== 'complete')
    throw new UwGraphUnavailableError(
      graph.diagnostics.length > 0
        ? graph.diagnostics
        : refused(uw, 'graph-incomplete', 'Created UW native graph is incomplete'),
    )
  const ownRead = await installedUwContracts.readComposedWorkflowHistory([uw], github)
  const ownHistory = ownRead.histories[0]
  if (!ownRead.ok || ownRead.histories.length !== 1 || ownHistory === undefined)
    throw new UwGraphUnavailableError(refused(uw, 'history-incomplete', 'Created UW identity history is incomplete'))
  const framed = requiresFramingClosure(uw, ownHistory)
  const observation = framed
    ? await installedUwContracts.readUwCompletionObservation(uw, github, (histories) =>
        loadReviewClassCatalogues({ histories, cwd: options.cwd, gh: options.gh ?? defaultGh() }),
      )
    : null
  if (observation !== null && (observation.status !== 'complete' || observation.graph.status !== 'complete'))
    throw new UwGraphUnavailableError(
      observation.status === 'incomplete'
        ? observation.diagnostics
        : refused(uw, 'graph-incomplete', 'Created UW native graph is incomplete'),
    )
  return createdFacts(uw, observation?.graph ?? graph, observation?.histories ?? ownRead.histories)
}

export function createInstalledObservedUwReadPort(input: {
  observation: UwCompletionObservation
  assessmentReplay?: InstalledUwReadOptions['assessmentReplay']
}): UwReadPort {
  return createObservedUwReadPort(installedUwContracts, input)
}
