import { createHash } from 'node:crypto'
import { canonicalValueDigest } from './action-input.ts'
import { validateRecoveryAdoptionPlan } from './fix-recovery-adoption-assessment.ts'
import type { FixRecoveryProposal } from './fix-recovery-control-schema.ts'
import { makeRecoveryCuts } from './fix-recovery-cuts.ts'
import { discoverRecoveryHistoricalSnapshot } from './fix-recovery-discovery.ts'
import { matchesCompletePin } from './fix-recovery-discovery-records.ts'
import { reconstructRecoveryHistoricalCut, validRecoveryHistoricalGraph } from './fix-recovery-historical-cut.ts'
import { fixRecoveryExpected } from './fix-recovery-proposal.ts'
import type { FixOwnerOpenedPayload, FixOwnerSettledPayload } from './fix-recovery-schema.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope, sameRef } from './record-diagnostics.ts'
import type { Result } from './result.ts'
import { scopeKey } from './uw-graph.ts'
import { bindExternalRef } from './workflow-control.ts'

export type RecoveryHistoricalFacts = {
  histories: DecodedHistory[]
  opening: FixOwnerOpenedPayload
  settlement: FixOwnerSettledPayload
}

/** Structural fact reconstruction only; not replay membership or execution authority. */
export function inspectRecoveryHistoricalFacts(
  proposal: FixRecoveryProposal,
  histories: readonly DecodedHistory[],
  recordPinsBefore?: number,
): Result<RecoveryHistoricalFacts> {
  const initial = validateHistoricalObservation(proposal)
  if (!initial.ok) return initial
  const observation = proposal.observation
  const result = reconstructRecoveryHistoricalCut(observation.histories, histories, recordPinsBefore)
  if (!result.ok) return result
  // Cite only this cut's decoded membership; foreign expansion pins are carried separately on its sources.
  const snapshot = result.value
  const discovered = validateHistoricalDiscovery(proposal, snapshot)
  if (!discovered.ok) return discovered
  const ownerHistory = snapshot.find((history) => equalScope(history.source.scope, proposal.uw))
  if (ownerHistory === undefined) return fail('owner source is missing from historical cut')
  const opened = bindExternalRef(proposal.opened, ownerHistory)
  const settled = bindExternalRef(proposal.settled, ownerHistory)
  if (
    !opened.ok ||
    opened.value.kind !== 'fix-owner' ||
    opened.value.payload.phase !== 'opened' ||
    !settled.ok ||
    settled.value.kind !== 'fix-owner' ||
    settled.value.payload.phase !== 'settled'
  )
    return fail('owner opening or settlement does not bind')
  const opening = opened.value.payload
  const settlement = settled.value.payload
  const authority = validateHistoricalAuthority(proposal, snapshot, opening, settlement)
  if (!authority.ok) return authority
  const cuts = makeRecoveryCuts(opening, settlement, snapshot)
  if (!cuts.ok) return cuts
  if (canonicalValueDigest(cuts.value) !== canonicalValueDigest(proposal.cuts))
    return fail('reconstructed publication cuts differ from proposal')
  return { ok: true, value: { histories: snapshot, opening, settlement } }
}

const fail = (detail: string): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic('unconfirmed', `Recovery historical facts: ${detail}`)],
})

function strictlyOrdered(values: readonly string[]): boolean {
  return values.every((value, index) => {
    const previous = values[index - 1]
    return index === 0 || (previous !== undefined && previous < value)
  })
}

function validateHistoricalObservation(proposal: FixRecoveryProposal): Result<true> {
  const observation = proposal.observation
  if (!strictlyOrdered(observation.histories.map((cut) => scopeKey(cut.scope))))
    return fail('historical source scopes are not uniquely ordered')
  if (!validRecoveryHistoricalGraph(observation.graph)) return fail('historical graph validation failed')
  if (!equalScope(observation.graph.root, proposal.uw)) return fail('historical graph root differs from proposal UW')
  if (canonicalValueDigest(proposal.expected) !== canonicalValueDigest(fixRecoveryExpected(observation)))
    return fail('proposal expected digests differ from observation')
  if (!equalScope(proposal.control.scope, proposal.pullRequest))
    return fail('control scope differs from proposal pull request')
  if (proposal.operationId !== proposal.control.operationId)
    return fail('control operation identity differs from proposal')
  if (canonicalValueDigest(observation) !== proposal.observationDigest)
    return fail('observation digest differs from proposal')
  if (
    createHash('sha256').update(observation.local.status.stdout, 'utf8').digest('hex') !==
    observation.local.statusDigest
  )
    return fail('local status digest differs from stdout')
  if (observation.local.clean !== (observation.local.status.stdout.trim() === ''))
    return fail('local cleanliness differs from stdout')
  return validateHistoricalVector(proposal)
}

function validateHistoricalVector(proposal: FixRecoveryProposal): Result<true> {
  const observation = proposal.observation
  const vector = observation.authority.accepted.versionVector
  for (const [index, ref] of vector.entries()) {
    const parent = vector[index + 1]
    const node = observation.graph.nodes.find((entry) => equalScope(entry.uw, ref.uw))
    if (
      node === undefined ||
      node.labels.some((label) => label.startsWith('wayfinder:')) ||
      (parent === undefined ? node.parent !== null : node.parent === null || !equalScope(node.parent, parent.uw))
    )
      return fail('accepted Spec vector does not match historical graph')
  }
  return { ok: true, value: true }
}

function validateHistoricalDiscovery(proposal: FixRecoveryProposal, snapshot: DecodedHistory[]): Result<true> {
  const observation = proposal.observation
  const discovery = discoverRecoveryHistoricalSnapshot({
    uw: proposal.uw,
    histories: snapshot,
    accepted: observation.authority.accepted,
    graph: { status: 'semantic', ...observation.graph },
    opened: proposal.opened,
  })
  if (discovery.status === 'blocked') return { ok: false, diagnostics: [...discovery.diagnostics] }
  if (
    discovery.status !== 'interrupted' ||
    !sameRef(discovery.owner, proposal.opened) ||
    !sameRef(discovery.settled, proposal.settled) ||
    canonicalValueDigest(discovery.phase) !== canonicalValueDigest(proposal.target) ||
    (proposal.phase === 'close-publication' && discovery.phase.kind !== 'publication-prefix') ||
    (proposal.phase === 'close-predecision' && discovery.phase.kind !== 'request-before-decision') ||
    (proposal.phase === 'adopt-decision' && discovery.phase.kind !== 'decided')
  )
    return fail('historical owner, settlement or reconstructed phase differs from proposal')
  if (proposal.phase === 'adopt-decision') {
    if (
      !equalScope(proposal.claimReservation.scope, proposal.uw) ||
      snapshot.some(
        (history) =>
          equalScope(history.source.scope, proposal.claimReservation.scope) &&
          history.operations.some(
            (operation) =>
              operation.operationId === proposal.claimReservation.operationId ||
              operation.recordId === proposal.claimReservation.recordId,
          ),
      )
    )
      return fail('adoption claim reservation conflicts with historical operations')
    const plan = validateRecoveryAdoptionPlan({ proposal, histories: snapshot })
    if (!plan.ok) return plan
  }
  return { ok: true, value: true }
}

function validateHistoricalAuthority(
  proposal: FixRecoveryProposal,
  snapshot: DecodedHistory[],
  opening: FixOwnerOpenedPayload,
  settlement: FixOwnerSettledPayload,
): Result<true> {
  const observation = proposal.observation
  if (
    !observation.local.clean ||
    canonicalValueDigest(settlement.local) !==
      canonicalValueDigest({
        head: observation.local.head,
        remoteHead: observation.local.remoteHead,
        statusDigest: observation.local.statusDigest,
        clean: observation.local.clean,
      })
  )
    return fail('current local state differs from settled local facts or is not clean')
  const common = opening.common
  const authority = observation.authority
  const sortFiles = (plugin: typeof authority.plugin) => ({
    ...plugin,
    files: [...plugin.files].sort((a, b) => {
      const left = [a.repository, a.commit, a.path].join('\0')
      const right = [b.repository, b.commit, b.path].join('\0')
      return left < right ? -1 : left > right ? 1 : 0
    }),
  })
  const fileKeys = authority.plugin.files.map((file) => [file.repository, file.commit, file.path].join('\0'))
  if (!strictlyOrdered(fileKeys)) return fail('plugin file pins are not uniquely ordered')
  if (
    !sameRef(common.binding, proposal.binding) ||
    !sameRef(common.mandate, proposal.mandate) ||
    !sameRef(authority.binding.identity, proposal.binding) ||
    !sameRef(authority.mandate.identity, proposal.mandate) ||
    !matchesCompletePin(snapshot, authority.binding) ||
    !matchesCompletePin(snapshot, authority.mandate) ||
    canonicalValueDigest(sortFiles(common.plugin)) !== canonicalValueDigest(authority.plugin) ||
    canonicalValueDigest(common.configuration) !== canonicalValueDigest(authority.configuration) ||
    canonicalValueDigest(common.accepted) !== canonicalValueDigest(authority.accepted) ||
    common.acceptedDigest !== canonicalValueDigest(authority.accepted) ||
    !equalScope(common.pullRequest, proposal.pullRequest) ||
    !equalScope(observation.pullRequest.scope, proposal.pullRequest) ||
    canonicalValueDigest(common.destination) !== canonicalValueDigest(observation.pullRequest.destination)
  )
    return fail('recorded authority, pin, accepted Spec or destination mismatch')
  const bindingHistory = snapshot.find((history) => equalScope(history.source.scope, proposal.binding.scope))
  if (bindingHistory === undefined) return fail('binding source is absent from historical cut')
  const binding = bindExternalRef(proposal.binding, bindingHistory)
  if (
    !binding.ok ||
    binding.value.kind !== 'workflow-binding' ||
    binding.value.payload.branch !== observation.pullRequest.branch ||
    binding.value.payload.base !== observation.pullRequest.base
  )
    return fail('binding branch or base does not match observed pull request')
  return validateHistoricalHost(proposal, opening)
}

function validateHistoricalHost(proposal: FixRecoveryProposal, opening: FixOwnerOpenedPayload): Result<true> {
  const host = proposal.observation.host
  const common = opening.common
  const qualified = common.host
  if (
    qualified.kind !== 'linux-qualified' ||
    qualified.admission.destinationDigest !==
      canonicalValueDigest([
        common.destination.authority,
        common.destination.publicationRepository,
        common.destination.destinationRef,
      ]) ||
    canonicalValueDigest(host.namespace) !== canonicalValueDigest(qualified.namespace) ||
    host.process.bootId !== host.namespace.bootId ||
    host.process.effectiveUid !== host.namespace.effectiveUid ||
    host.process.userNamespace !== host.namespace.userNamespace ||
    host.process.pidNamespace !== host.namespace.pidNamespace
  )
    return fail('host qualification or namespace does not match owner')
  if (host.prior.kind === 'sealed-drained-live') {
    if (
      canonicalValueDigest(host.process) !== canonicalValueDigest(qualified.process) ||
      canonicalValueDigest(host.root) !== canonicalValueDigest(common.root)
    )
      return fail('live owner process or root differs from opening')
  } else if (host.prior.ended.basis === 'pid-reused') {
    const seen = host.prior.ended.observed
    if (
      seen.pid !== qualified.process.pid ||
      seen.bootId !== qualified.process.bootId ||
      seen.userNamespace !== qualified.process.userNamespace ||
      seen.pidNamespace !== qualified.process.pidNamespace ||
      seen.effectiveUid !== qualified.process.effectiveUid ||
      seen.processStartTicks === qualified.process.processStartTicks
    )
      return fail('pid-reuse observation does not prove prior owner ended')
  } else if (canonicalValueDigest(host.process) === canonicalValueDigest(qualified.process))
    return fail('ended owner still matches current process lifetime')
  return { ok: true, value: true }
}
