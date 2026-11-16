import { canonicalValueDigest } from './action-input.ts'
import { validateRecoveryAdoptionPlan } from './fix-recovery-adoption-assessment.ts'
import { buildAdoptionRecord, buildCloseRecord } from './fix-recovery-confirmed-record.ts'
import {
  type FixRecoveryNativePreparation,
  type FixRecoveryObservation,
  type FixRecoveryProposal,
  fixRecoveryProposalSchema,
} from './fix-recovery-control-schema.ts'
import { makeRecoveryCuts } from './fix-recovery-cuts.ts'
import { discoverRecoveryHistoricalSnapshot } from './fix-recovery-discovery.ts'
import { reconstructRecoveryHistoricalCut } from './fix-recovery-historical-cut.ts'
import { inspectRecoveryHistoricalFacts } from './fix-recovery-historical-facts.ts'
import type { ReservedRecordIdentity } from './fix-recovery-identities.ts'
import {
  fixRecoveryExpected,
  fixRecoveryGraphFacts,
  fixRecoveryObservationDigest,
  fixRecoveryProposalDigest,
} from './fix-recovery-proposal.ts'
import { unclosedLineage } from './fix-recovery-replay.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Result } from './result.ts'
import type { UwGraphObservation } from './uw-graph.ts'
import type { OperatorConfirmationEvidence } from './uw-identity-schema.ts'
import { bindExternalRef } from './workflow-control.ts'

type CloseProposal = Extract<FixRecoveryProposal, { phase: 'close-publication' | 'close-predecision' }>
type Control = Extract<CanonicalRecord, { kind: 'fix-recovery' }>
export type PreparedFixRecoveryClose = Readonly<{ proposal: CloseProposal; digest: string }>
type AdoptionProposal = Extract<FixRecoveryProposal, { phase: 'adopt-decision' }>
export type PreparedFixRecoveryAdoption = Readonly<{ proposal: AdoptionProposal; digest: string }>
const fail = (message: string): Result<never> => ({ ok: false, diagnostics: [diagnostic('unconfirmed', message)] })

function reservationCollides(
  reservation: ReservedRecordIdentity<string>,
  histories: readonly DecodedHistory[],
): boolean {
  return histories.some(
    (history) =>
      equalScope(history.source.scope, reservation.scope) &&
      history.operations.some(
        (operation) => operation.operationId === reservation.operationId || operation.recordId === reservation.recordId,
      ),
  )
}

function adoptionReservationsCollide(
  control: ReservedRecordIdentity<'fix-recovery'>,
  claim: ReservedRecordIdentity<'fix-owner'>,
  uw: FixRecoveryObservation['authority']['accepted']['own']['uw'],
  histories: readonly DecodedHistory[],
): boolean {
  return (
    !equalScope(claim.scope, uw) || reservationCollides(control, histories) || reservationCollides(claim, histories)
  )
}

/** Derive a close proposal from the actual finite read, never from caller-labelled phase or cuts. */
export function prepareFixRecoveryClose(input: {
  control: ReservedRecordIdentity<'fix-recovery'>
  observation: FixRecoveryObservation
  histories: readonly DecodedHistory[]
}): Result<PreparedFixRecoveryClose> {
  const { control, observation, histories } = input
  const snapshot = reconstructRecoveryHistoricalCut(observation.histories, histories)
  if (
    histories.some(
      (history) =>
        equalScope(history.source.scope, control.scope) &&
        history.operations.some(
          (operation) => operation.operationId === control.operationId || operation.recordId === control.recordId,
        ),
    )
  )
    return fail('Recovery control reservation collides with an existing raw operation')
  if (!snapshot.ok) return snapshot
  const uw = observation.authority.accepted.own.uw
  const lineage = unclosedLineage(snapshot.value, uw, new Set())
  if (!lineage.ok) return lineage
  const found = discoverRecoveryHistoricalSnapshot({
    uw,
    histories: snapshot.value,
    accepted: observation.authority.accepted,
    graph: { status: 'semantic', ...observation.graph },
    opened: lineage.value.opened,
  })
  if (found.status !== 'interrupted' || found.phase.kind === 'decided')
    return fail('No authenticated close-eligible interrupted phase')
  const home = snapshot.value.find((history) => equalScope(history.source.scope, uw))
  if (home === undefined) return fail('Recovery owner history is unavailable')
  const opened = bindExternalRef(found.owner, home)
  const settled = bindExternalRef(found.settled, home)
  if (
    !opened.ok ||
    opened.value.kind !== 'fix-owner' ||
    opened.value.payload.phase !== 'opened' ||
    !settled.ok ||
    settled.value.kind !== 'fix-owner' ||
    settled.value.payload.phase !== 'settled'
  )
    return fail('Recovery owner anchors are unavailable')
  const cuts = makeRecoveryCuts(opened.value.payload, settled.value.payload, snapshot.value)
  if (!cuts.ok) return cuts
  const common = opened.value.payload.common
  const phase =
    found.phase.kind === 'publication-prefix'
      ? { phase: 'close-publication' as const, target: found.phase }
      : { phase: 'close-predecision' as const, target: found.phase }
  const parsed = fixRecoveryProposalSchema.safeParse({
    format: 'omp-build-fix-recovery-proposal/1',
    operationId: control.operationId,
    control,
    uw,
    pullRequest: common.pullRequest,
    binding: common.binding,
    mandate: common.mandate,
    predecessor: lineage.value.predecessor,
    opened: found.owner,
    settled: found.settled,
    cuts: cuts.value,
    observation,
    observationDigest: fixRecoveryObservationDigest(observation),
    expected: fixRecoveryExpected(observation),
    ...phase,
  })
  if (!parsed.success || parsed.data.phase === 'adopt-decision') return fail('Close proposal is malformed')
  const checked = inspectRecoveryHistoricalFacts(parsed.data, histories)
  if (!checked.ok) return checked
  if (
    !observation.local.clean ||
    canonicalValueDigest(settled.value.payload.local) !==
      canonicalValueDigest({
        head: observation.local.head,
        remoteHead: observation.local.remoteHead,
        statusDigest: observation.local.statusDigest,
        clean: observation.local.clean,
      })
  )
    return fail('Local state is dirty or changed since the sealed owner observation')
  return { ok: true, value: { proposal: parsed.data, digest: fixRecoveryProposalDigest(parsed.data) } }
}
/** Reassess the original R/D and its real current disposition and native preparation. */
export function prepareFixRecoveryAdoption(input: {
  control: ReservedRecordIdentity<'fix-recovery'>
  claimReservation: ReservedRecordIdentity<'fix-owner'>
  observation: FixRecoveryObservation
  histories: readonly DecodedHistory[]
  graph: UwGraphObservation
  nativePreparation: FixRecoveryNativePreparation
}): Result<PreparedFixRecoveryAdoption> {
  const { control, claimReservation, observation, histories, graph, nativePreparation } = input
  const uw = observation.authority.accepted.own.uw
  const graphFacts = fixRecoveryGraphFacts(graph)
  if (!graphFacts.ok || canonicalValueDigest(graphFacts.value) !== canonicalValueDigest(observation.graph))
    return fail('Adoption native graph differs from the current captured observation')
  if (adoptionReservationsCollide(control, claimReservation, uw, histories))
    return fail('Adoption control or claim reservation collides with a native operation')
  const snapshot = reconstructRecoveryHistoricalCut(observation.histories, histories)
  if (!snapshot.ok) return snapshot
  const lineage = unclosedLineage(snapshot.value, uw, new Set())
  if (!lineage.ok) return lineage
  const found = discoverRecoveryHistoricalSnapshot({
    uw,
    histories: snapshot.value,
    accepted: observation.authority.accepted,
    graph: { status: 'semantic', ...observation.graph },
    opened: lineage.value.opened,
  })
  if (found.status !== 'interrupted' || found.phase.kind !== 'decided')
    return fail('No authenticated adoption-eligible decision')
  const home = snapshot.value.find((history) => equalScope(history.source.scope, uw))
  if (home === undefined) return fail('Recovery owner history is unavailable')
  const opened = bindExternalRef(found.owner, home)
  const settled = bindExternalRef(found.settled, home)
  if (
    !opened.ok ||
    opened.value.kind !== 'fix-owner' ||
    opened.value.payload.phase !== 'opened' ||
    !settled.ok ||
    settled.value.kind !== 'fix-owner' ||
    settled.value.payload.phase !== 'settled'
  )
    return fail('Recovery owner anchors are unavailable')
  const cuts = makeRecoveryCuts(opened.value.payload, settled.value.payload, snapshot.value)
  if (!cuts.ok) return cuts
  const common = opened.value.payload.common
  const parsed = fixRecoveryProposalSchema.safeParse({
    format: 'omp-build-fix-recovery-proposal/1',
    operationId: control.operationId,
    control,
    uw,
    pullRequest: common.pullRequest,
    binding: common.binding,
    mandate: common.mandate,
    predecessor: lineage.value.predecessor,
    opened: found.owner,
    settled: found.settled,
    cuts: cuts.value,
    observation,
    observationDigest: fixRecoveryObservationDigest(observation),
    expected: fixRecoveryExpected(observation),
    phase: 'adopt-decision',
    target: found.phase,
    claimReservation,
    nativePreparation,
  })
  if (!parsed.success || parsed.data.phase !== 'adopt-decision') return fail('Adoption proposal is malformed')
  const historical = inspectRecoveryHistoricalFacts(parsed.data, histories)
  if (!historical.ok) return historical
  const current = validateRecoveryAdoptionPlan({ proposal: parsed.data, histories: snapshot.value, graph })
  if (!current.ok) return current
  return { ok: true, value: { proposal: parsed.data, digest: fixRecoveryProposalDigest(parsed.data) } }
}

/** Confirmation is checked against a fresh assessment under the held destination lease. */
export function buildConfirmedFixRecoveryAdoption(input: {
  prepared: PreparedFixRecoveryAdoption
  fresh: PreparedFixRecoveryAdoption
  confirmation: OperatorConfirmationEvidence
  histories: readonly DecodedHistory[]
  graph: UwGraphObservation
}): Result<Control> {
  const { proposal, digest } = input.prepared
  const fresh = input.fresh.proposal
  const actual = prepareFixRecoveryAdoption({
    control: fresh.control,
    claimReservation: fresh.claimReservation,
    observation: fresh.observation,
    nativePreparation: fresh.nativePreparation,
    histories: input.histories,
    graph: input.graph,
  })
  if (
    !actual.ok ||
    actual.value.digest !== input.fresh.digest ||
    digest !== fixRecoveryProposalDigest(proposal) ||
    input.fresh.digest !== digest ||
    canonicalValueDigest(fresh) !== digest ||
    input.confirmation.route !== 'omp-native-command' ||
    input.confirmation.operationId !== proposal.operationId ||
    input.confirmation.proposalDigest !== digest
  )
    return fail('Adoption confirmation or fresh proposal does not match')
  return buildAdoptionRecord(proposal, digest, input.confirmation)
}

/** Caller must freshly rerun prepareFixRecoveryClose under its held native lease before using confirmation. */
export function buildConfirmedFixRecoveryClose(input: {
  prepared: PreparedFixRecoveryClose
  fresh: PreparedFixRecoveryClose
  confirmation: OperatorConfirmationEvidence
  histories: readonly DecodedHistory[]
}): Result<Control> {
  const { proposal, digest } = input.prepared
  const actual = prepareFixRecoveryClose({
    control: proposal.control,
    observation: input.fresh.proposal.observation,
    histories: input.histories,
  })
  if (!actual.ok || actual.value.digest !== input.fresh.digest)
    return fail('Fresh recovery proposal no longer authenticates')
  if (
    digest !== fixRecoveryProposalDigest(proposal) ||
    input.fresh.digest !== digest ||
    canonicalValueDigest(input.fresh.proposal) !== digest ||
    input.confirmation.route !== 'omp-native-command' ||
    input.confirmation.operationId !== proposal.operationId ||
    input.confirmation.proposalDigest !== digest
  )
    return fail('Confirmation or fresh recovery proposal does not match')
  return buildCloseRecord(proposal, digest, input.confirmation)
}
