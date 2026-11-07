import type { Gh, GitHubOptions } from '../adapters/github/types.ts'
import {
  assessUwAdmission,
  assessUwCompletion,
  parseIssueSpecBody,
  readComposedWorkflowHistory,
  readUwCompletionObservation,
  readUwGraph,
  resolveAcceptedSpec,
  resolveOwnSpecAuthority,
  resolveSpecIdentityLedger,
  selectApplicableMandate,
} from '../dist/contracts.js'
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
  const github = readOptions(options)
  return {
    async readUw(uw): Promise<UwRead> {
      const observation = await contracts.readUwCompletionObservation(uw, github, (histories) =>
        loadReviewClassCatalogues({ histories, cwd: options.cwd, gh: options.gh ?? defaultGh() }),
      )
      const root = observation.graph.nodes.find(
        (node) => node.uw.repository === uw.repository && node.uw.target === uw.target,
      )
      if (root === undefined) {
        const diagnostics =
          observation.status === 'incomplete'
            ? observation.diagnostics
            : refused(uw, 'graph-root-missing', `UW graph root ${uw.target} is absent`)
        throw new UwGraphUnavailableError(diagnostics)
      }
      const reader = createObservedUwReadPort(contracts, { observation, assessmentReplay: options.assessmentReplay })
      const read = await reader.readUw(uw)
      return withTransitionAdmission(contracts, read)
    },
  }
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
  const completion = contracts.assessUwCompletion(input.observation)
  const history: HistoryObservation =
    input.history ??
    (input.observation.status === 'complete'
      ? { ok: true, histories: input.observation.histories }
      : {
          ok: false,
          reason: 'incomplete',
          histories: input.observation.histories,
          diagnostics: input.observation.diagnostics,
        })
  const causalObservation: UwRead['causalObservation'] =
    input.observation.status === 'complete' && history.ok && history.histories === input.observation.histories
      ? { status: 'complete', histories: input.observation.histories, catalogues: input.observation.catalogues }
      : { status: 'unavailable' }
  let reader: UwReadPort
  reader = {
    async readUw(uw): Promise<UwRead> {
      return assembleUwRead(contracts, {
        uw,
        graph: input.observation.graph,
        history,
        catalogues: input.observation.catalogues,
        observation: input.observation,
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
/** Creation readback proves only native framing and the created issue's own identity ledger. */
export async function readCreatedUw(uw: Scope, options: InstalledUwReadOptions): Promise<CreatedUwRead> {
  const github = readOptions(options)
  const graph = await installedUwContracts.readUwGraph(uw, github)
  if (
    graph.status !== 'complete' ||
    !graph.nodes.some((node) => node.uw.repository === uw.repository && node.uw.target === uw.target)
  )
    throw new UwGraphUnavailableError(refused(uw, 'graph-incomplete', 'Created UW native graph is incomplete'))
  const composed = await installedUwContracts.readComposedWorkflowHistory([uw], github)
  if (!composed.ok)
    throw new UwGraphUnavailableError(refused(uw, 'history-incomplete', 'Created UW identity history is incomplete'))
  const root = graph.nodes.find((node) => node.uw.repository === uw.repository && node.uw.target === uw.target)
  if (root === undefined) throw new TypeError("Cannot read properties of undefined (reading 'raw')")
  const parsed = installedUwContracts.parseIssueSpecBody({ uw, raw: root.raw })
  const proposed =
    parsed.status === 'conformant'
      ? { ok: true as const, snapshot: parsed.snapshot }
      : { ok: false as const, diagnostics: [...parsed.diagnostics] }
  const own = composed.histories.find(
    (entry) => entry.source.scope.repository === uw.repository && entry.source.scope.target === uw.target,
  )
  if (own === undefined)
    throw new UwGraphUnavailableError(refused(uw, 'history-missing', 'Created UW identity history is absent'))
  const identity = installedUwContracts.resolveSpecIdentityLedger({
    uw,
    history: own,
    histories: composed.histories,
    accepted: null,
  })
  return { uw, parsed, proposed, identity, histories: composed.histories, graph }
}

export function createInstalledObservedUwReadPort(input: {
  observation: UwCompletionObservation
  assessmentReplay?: InstalledUwReadOptions['assessmentReplay']
}): UwReadPort {
  return createObservedUwReadPort(installedUwContracts, input)
}
