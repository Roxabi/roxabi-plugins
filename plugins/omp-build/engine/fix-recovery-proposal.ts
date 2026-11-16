import { createHash } from 'node:crypto'
import { canonicalValueDigest } from './action-input.ts'
import {
  type FixRecoveryObservation,
  type FixRecoveryProposal,
  fixRecoveryProposalSchema,
} from './fix-recovery-control-schema.ts'
import { diagnostic, equalScope } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Result } from './result.ts'
import { scopeKey, type UwGraphObservation, validateUwGraph } from './uw-graph.ts'

/** Projects only a validated native graph; these facts alone grant no authority. */
export function fixRecoveryGraphFacts(graph: UwGraphObservation): Result<FixRecoveryObservation['graph']> {
  if (graph.status !== 'complete' || !validateUwGraph(graph).ok)
    return { ok: false, diagnostics: [diagnostic('unconfirmed', 'Recovery native graph is incomplete or invalid')] }
  const distinct = (values: readonly string[]) => new Set(values).size === values.length
  if (
    !distinct(graph.nodes.map((node) => scopeKey(node.uw))) ||
    graph.nodes.some(
      (node) =>
        createHash('sha256').update(node.raw.body, 'utf8').digest('hex') !== node.raw.bodySha256 ||
        !distinct(node.labels) ||
        !distinct(node.wayfinderLabels) ||
        !distinct(node.children.map(scopeKey)) ||
        !distinct(node.blockers.map(scopeKey)),
    )
  )
    return {
      ok: false,
      diagnostics: [diagnostic('unconfirmed', 'Recovery native graph has a mismatched body or duplicate set member')],
    }
  const scope = (value: { repository: string; target: string }) => ({
    repository: value.repository,
    target: value.target,
  })
  const compareScopes = (a: { repository: string; target: string }, b: { repository: string; target: string }) =>
    scopeKey(a) < scopeKey(b) ? -1 : scopeKey(a) > scopeKey(b) ? 1 : 0
  const scopes = (values: readonly { repository: string; target: string }[]) => values.map(scope).sort(compareScopes)
  const nodes = graph.nodes
    .map((node) => ({
      uw: scope(node.uw),
      title: node.title,
      raw: { reference: node.raw.reference, body: node.raw.body, bodySha256: node.raw.bodySha256 },
      labels: [...node.labels].sort(),
      wayfinderLabels: [...node.wayfinderLabels].sort(),
      parent: node.parent === null ? null : scope(node.parent),
      children: scopes(node.children),
      blockers: scopes(node.blockers),
      native: { ...node.native },
    }))
    .sort((a, b) => compareScopes(a.uw, b.uw))
  return { ok: true, value: { root: scope(graph.root), nodes } }
}

export function fixRecoveryObservationDigest(observation: FixRecoveryObservation): string {
  return canonicalValueDigest(observation)
}

export function fixRecoveryProposalDigest(proposal: FixRecoveryProposal): string {
  return canonicalValueDigest(proposal)
}

/** Canonical digest preimages; this calculation alone conveys no authority. */
export function fixRecoveryExpected(observation: FixRecoveryObservation): FixRecoveryProposal['expected'] {
  const { histories, graph, authority, pullRequest, local } = observation
  return {
    currentStateDigest: canonicalValueDigest({
      format: 'omp-build-fix-recovery-current-state/1',
      histories,
      graph,
      authority,
      pullRequest,
      local,
    }),
    headDigest: canonicalValueDigest({
      pullRequest: pullRequest.scope,
      candidateGitSHA: pullRequest.candidateGitSHA,
      baseGitSHA: pullRequest.baseGitSHA,
      localHead: local.head,
      remoteHead: local.remoteHead,
      destination: pullRequest.destination,
    }),
    pinDigest: canonicalValueDigest({ plugin: authority.plugin, configuration: authority.configuration }),
    mandateDigest: authority.mandate.envelopeDigest,
    acceptedSpecDigest: canonicalValueDigest(authority.accepted),
  }
}

/** Reconstruct and checksum the exact displayed preimage; replay must separately authenticate the finite cut. */
export function fixRecoveryProposalFromControl(
  record: Extract<CanonicalRecord, { kind: 'fix-recovery' }>,
): Result<FixRecoveryProposal> {
  const payload = record.payload
  const { repository, target, runId, operationId, recordId } = record
  const common = {
    format: 'omp-build-fix-recovery-proposal/1' as const,
    operationId,
    control: { scope: { repository, target }, kind: 'fix-recovery' as const, runId, operationId, recordId },
    uw: payload.uw,
    pullRequest: payload.pullRequest,
    binding: payload.binding,
    mandate: payload.mandate,
    predecessor: payload.predecessor,
    opened: payload.opened,
    settled: payload.settled,
    cuts: payload.cuts,
    observation: payload.observation,
    observationDigest: payload.observationDigest,
    expected: fixRecoveryExpected(payload.observation),
  }
  const phase =
    payload.phase === 'adopt-decision'
      ? {
          phase: payload.phase,
          target: payload.target,
          claimReservation: payload.claimReservation,
          nativePreparation: payload.nativePreparation,
        }
      : { phase: payload.phase, target: payload.target }
  const parsed = fixRecoveryProposalSchema.safeParse({ ...common, ...phase })
  if (
    !parsed.success ||
    !equalScope(record, payload.pullRequest) ||
    payload.observationDigest !== fixRecoveryObservationDigest(payload.observation) ||
    payload.confirmation.operationId !== operationId ||
    payload.confirmation.route !== 'omp-native-command' ||
    payload.confirmation.proposalDigest !== payload.proposalDigest ||
    fixRecoveryProposalDigest(parsed.data) !== payload.proposalDigest
  )
    return {
      ok: false,
      diagnostics: [diagnostic('unconfirmed', 'Recovery proposal or confirmation preimage does not match its control')],
    }
  return { ok: true, value: parsed.data }
}
