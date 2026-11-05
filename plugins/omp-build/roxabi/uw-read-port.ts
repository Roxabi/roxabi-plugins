import type { Gh, GitHubOptions } from '../adapters/github/types.ts'
import {
  assessUwAdmission,
  createReviewClassCatalogues,
  observeCauseSisters,
  parseIssueSpecBody,
  readCauseHistoryClosure,
  readComposedWorkflowHistory,
  readUwGraph,
  resolveAcceptedSpec,
  resolveOwnSpecAuthority,
  resolveSpecIdentityLedger,
  selectApplicableMandate,
} from '../dist/contracts.js'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import type { ReviewClassCatalogues } from '../engine/review-class-catalogue.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { UwGraphObservation } from '../engine/uw-graph.ts'
import { defaultGh } from './feature-engine.ts'
import { withRoxabiGitHubPolicy } from './github-policy.ts'
import { loadReviewClassCatalogues } from './review-class-catalogues.ts'
import type { UwRead, UwReadPort } from './uw-contract.ts'
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
          history: { ok: false, reason: composed.reason, diagnostics: composed.diagnostics },
          catalogues: createReviewClassCatalogues([]),
        })
      }
      const closure = await readCauseHistoryClosure(composed.histories, (needed) =>
        contracts.readComposedWorkflowHistory(needed, github),
      )
      if (!closure.ok) {
        return assembleUwRead(contracts, {
          uw,
          graph,
          history: { ok: false, reason: closure.reason, diagnostics: closure.diagnostics },
          catalogues: createReviewClassCatalogues([]),
        })
      }
      const catalogues = await loadReviewClassCatalogues({
        histories: closure.histories,
        cwd: options.cwd,
        gh: options.gh ?? defaultGh(),
      })
      const observedGraph = await observeCauseSisters(
        graph,
        closure.histories,
        (scope) => contracts.readUwGraph(scope, github),
        catalogues,
      )
      const reader = createObservedUwReadPort(contracts, {
        graph: observedGraph,
        histories: closure.histories,
        catalogues,
        assessmentReplay: options.assessmentReplay,
      })
      const read = await reader.readUw(uw)
      read.causalObservation = { status: 'complete', histories: read.histories, catalogues: read.catalogues }
      return withTransitionAdmission(contracts, read, reader)
    },
  }
}

/** Test seam for an already-observed graph and its composed histories. */
export function createObservedUwReadPort(
  contracts: InstalledUwContracts,
  input: {
    graph: UwGraphObservation
    histories: readonly DecodedHistory[]
    catalogues: ReviewClassCatalogues
    history?: HistoryObservation
    assessmentReplay?: InstalledUwReadOptions['assessmentReplay']
  },
): UwReadPort {
  let reader: UwReadPort
  reader = {
    async readUw(uw): Promise<UwRead> {
      return assembleUwRead(contracts, {
        uw,
        graph: input.graph,
        history: input.history ?? { ok: true, histories: input.histories },
        catalogues: input.catalogues,
        observedReader: reader,
        assessmentReplay: input.assessmentReplay,
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
/** Creation readback proves only native framing and the created issue's own identity ledger. */
export async function readCreatedUw(uw: Scope, options: InstalledUwReadOptions): Promise<UwRead> {
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
  const result = assembleUwRead(installedUwContracts, {
    uw,
    graph,
    history: { ok: true, histories: composed.histories },
    catalogues: await loadReviewClassCatalogues({
      histories: composed.histories,
      cwd: options.cwd,
      gh: options.gh ?? defaultGh(),
    }),
  })
  const diagnostics = refused(uw, 'creation-read-only', 'Creation readback does not assess delivery admission')
  return {
    ...result,
    accepted: { status: 'refused', diagnostics },
    admission: {
      framed: { ok: false, diagnostics },
      deliverable: { ok: false, diagnostics },
      applicability: 'own-only',
    },
  }
}

export function createInstalledObservedUwReadPort(input: {
  graph: UwGraphObservation
  histories: readonly DecodedHistory[]
  catalogues: ReviewClassCatalogues
}): UwReadPort {
  return createObservedUwReadPort(installedUwContracts, input)
}
