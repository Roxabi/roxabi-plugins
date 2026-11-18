import { originalDecisionMatches, resolveCorrectionRootBasis } from './correction-request-basis.ts'
import {
  type AuthenticatedRequest,
  deriveUnconfirmedDecision,
  deriveUnreservedDecision,
  type PhaseResult,
  phaseFailure,
} from './fix-recovery-discovery-decision-phase.ts'
import { derivePublicationPrefix } from './fix-recovery-discovery-publication.ts'
import {
  asOpenedRef,
  completeTrustedRecords,
  findCompleteRecord,
  findOperation,
  identityKey,
  matchesCompletePin,
  type OpenedRecord,
  pinForComplete,
} from './fix-recovery-discovery-records.ts'
import type { ReservedRecordIdentity } from './fix-recovery-identities.ts'
import { commentAsPartPin } from './fix-recovery-part-pins.ts'
import type { OutboundOperation } from './fix-recovery-phase-schema.ts'
import type { OpenedRef } from './fix-recovery-schema.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope } from './record-diagnostics.ts'
import { bindExternalRef } from './workflow-control.ts'

export function deriveInterruptedPhase(
  opening: OpenedRecord,
  outbound: readonly OutboundOperation[],
  histories: readonly DecodedHistory[],
): PhaseResult {
  const opened = asOpenedRef(opening)
  const intent = opening.payload.intent
  if (intent.kind === 'fresh-intake') {
    return deriveFreshIntake(opening, outbound, histories, opened, intent)
  }
  if (!matchesCompletePin(histories, intent.source))
    return phaseFailure('incomplete', 'Resume-decision opening lacks a complete source')
  if (!matchesCompletePin(histories, intent.request))
    return phaseFailure('incomplete', 'Resume-decision opening lacks a complete request')
  if (!matchesCompletePin(histories, intent.decision))
    return phaseFailure('incomplete', 'Resume-decision opening lacks a complete decision')
  return {
    ok: true,
    value: {
      kind: 'decided',
      opened,
      source: intent.source,
      request: intent.request,
      decision: intent.decision,
    },
  }
}
function deriveFreshIntake(
  opening: OpenedRecord,
  outbound: readonly OutboundOperation[],
  histories: readonly DecodedHistory[],
  opened: OpenedRef,
  intent: Extract<OpenedRecord['payload']['intent'], { kind: 'fresh-intake' }>,
): PhaseResult {
  const common = opening.payload.common
  for (const identity of [intent.sourceReservation, intent.requestReservation]) {
    if (
      identity.runId !== opening.runId ||
      !equalScope(identity.scope, common.pullRequest) ||
      identity.operationId !== `${common.operationPrefix}-${identity.recordId}` ||
      !outbound.some((entry) => identityKey(entry.identity) === identityKey(identity))
    )
      return phaseFailure('unbound', 'Fresh source or request is not enrolled under its owner')
  }
  if (findCompleteRecord(histories, intent.requestReservation) === null)
    return derivePublicationPrefix(opened, intent.sourceReservation, intent.requestReservation, outbound, histories)
  const sourceRecord = findCompleteRecord(histories, intent.sourceReservation)
  const requestRecord = findCompleteRecord(histories, intent.requestReservation)
  if (sourceRecord === null || requestRecord === null)
    return phaseFailure('incomplete', 'Complete request without complete source cannot authenticate recovery')
  const sourceOperation = findOperation(histories, intent.sourceReservation)
  const requestOperation = findOperation(histories, intent.requestReservation)
  if (sourceOperation === null || requestOperation === null)
    return { ok: false, diagnostics: [diagnostic('incomplete', 'Complete C0/R operations are missing')] }
  if (
    requestRecord.kind !== 'fix-request' ||
    sourceRecord.kind !== 'contribution' ||
    requestRecord.payload.requestContributionId !== sourceRecord.recordId ||
    !requestRecord.inputs.includes(sourceRecord.recordId)
  )
    return { ok: false, diagnostics: [diagnostic('unbound', 'Request does not bind its reserved source')] }
  const requestHome = histories.find((history) => equalScope(history.source.scope, requestRecord))
  if (requestHome === undefined)
    return { ok: false, diagnostics: [diagnostic('incomplete', 'Request history is unavailable')] }
  const rootBasis = resolveCorrectionRootBasis(requestHome, requestRecord)
  if (!rootBasis.ok) return phaseFailure('unbound', 'Request lacks its authenticated operator source basis')
  const authenticated = {
    sourceRecord,
    requestRecord,
    sourceOperation,
    requestOperation,
    requestHome,
    rootBasis,
    opening,
    outbound,
    histories,
    opened,
    intent,
  }
  if (requestRecord.payload.existingReviewId !== null) {
    return deriveExistingReview(authenticated)
  }
  return deriveFreshDecision(authenticated)
}
function deriveExistingReview({
  sourceRecord,
  requestRecord,
  sourceOperation,
  requestOperation,
  requestHome,
  rootBasis,
  histories,
  opened,
  intent,
}: AuthenticatedRequest): PhaseResult {
  const existingReviewId = requestRecord.payload.existingReviewId
  const records = completeTrustedRecords(histories).filter((record) => equalScope(record, requestRecord))
  const reviews = records.filter((record) => record.kind === 'review' && record.recordId === existingReviewId)
  const review = reviews[0]
  if (
    reviews.length !== 1 ||
    review === undefined ||
    review.kind !== 'review' ||
    !requestRecord.inputs.includes(review.recordId)
  )
    return { ok: false, diagnostics: [diagnostic('unbound', 'Request does not bind a unique complete review')] }
  const reviewHome = histories.find((history) => equalScope(history.source.scope, review))
  if (
    reviewHome === undefined ||
    !bindExternalRef({ scope: reviewHome.source.scope, kind: 'review', recordId: review.recordId }, reviewHome).ok
  )
    return phaseFailure('unconfirmed', 'Selected review is not an authenticated source')
  const decisions = records.filter(
    (record) => record.kind === 'decision' && record.recordId === review.payload.decisionId,
  )
  const decision = decisions[0]
  if (
    decisions.length !== 1 ||
    decision === undefined ||
    decision.kind !== 'decision' ||
    !review.inputs.includes(decision.recordId)
  )
    return phaseFailure('unbound', 'Review does not bind a unique complete decision')
  const identity: ReservedRecordIdentity<'decision'> = {
    scope: { repository: decision.repository, target: decision.target },
    kind: 'decision',
    runId: decision.runId,
    operationId: decision.operationId,
    recordId: decision.recordId,
  }
  const operation = findOperation(histories, identity)
  if (operation === null || findCompleteRecord(histories, identity) === null)
    return { ok: false, diagnostics: [diagnostic('incomplete', 'Review decision is not immutable')] }
  if (
    decision.payload.judgment.purpose !== 'review' ||
    !originalDecisionMatches(requestHome, requestRecord, decision, rootBasis.value.originalCandidate)
  )
    return phaseFailure('unbound', 'Review decision does not match the request synthesis root')
  return {
    ok: true,
    value: {
      kind: 'decided',
      opened,
      source: pinForComplete(intent.sourceReservation, sourceRecord, sourceOperation),
      request: pinForComplete(intent.requestReservation, requestRecord, requestOperation),
      decision: pinForComplete(identity, decision, operation),
    },
  }
}
function deriveFreshDecision(context: AuthenticatedRequest): PhaseResult {
  const { opening, outbound } = context
  const common = opening.payload.common
  const decisionReservations = outbound.filter((entry) => entry.identity.kind === 'decision')
  const decisionOutbound = decisionReservations[0]
  if (decisionReservations.length === 0) {
    return deriveUnreservedDecision(context)
  }
  if (
    decisionReservations.length !== 1 ||
    decisionOutbound === undefined ||
    decisionOutbound.identity.kind !== 'decision'
  )
    return phaseFailure('ambiguous', 'Settled outbound has multiple decision reservations')
  const decisionIdentity: ReservedRecordIdentity<'decision'> = { ...decisionOutbound.identity, kind: 'decision' }
  if (
    decisionIdentity.runId !== opening.runId ||
    !equalScope(decisionIdentity.scope, common.pullRequest) ||
    decisionIdentity.operationId !== `${common.operationPrefix}-${decisionIdentity.recordId}`
  )
    return { ok: false, diagnostics: [diagnostic('unbound', 'Decision reservation is not owned by this intake')] }
  return deriveReservedDecision(context, decisionIdentity, decisionOutbound.publication)
}

function deriveReservedDecision(
  context: AuthenticatedRequest,
  decisionIdentity: ReservedRecordIdentity<'decision'>,
  publication: OutboundOperation['publication'],
): PhaseResult {
  const {
    sourceRecord,
    requestRecord,
    sourceOperation,
    requestOperation,
    requestHome,
    rootBasis,
    histories,
    opened,
    intent,
  } = context
  const decisionOperation = findOperation(histories, decisionIdentity)
  const decisionRecord = findCompleteRecord(histories, decisionIdentity)
  if (publication.state === 'confirmed' && !matchesCompletePin(histories, publication.record))
    return { ok: false, diagnostics: [diagnostic('incomplete', 'Confirmed decision pin does not resolve')] }
  if (decisionRecord !== null && decisionOperation !== null) {
    if (
      decisionRecord.kind !== 'decision' ||
      decisionRecord.payload.judgment.purpose !== 'correction' ||
      !originalDecisionMatches(requestHome, requestRecord, decisionRecord, rootBasis.value.originalCandidate)
    )
      return phaseFailure('unbound', 'Decision does not match the request synthesis root')
    return {
      ok: true,
      value: {
        kind: 'decided',
        opened,
        source: pinForComplete(intent.sourceReservation, sourceRecord, sourceOperation),
        request: pinForComplete(intent.requestReservation, requestRecord, requestOperation),
        decision: pinForComplete(decisionIdentity, decisionRecord, decisionOperation),
      },
    }
  }
  if (publication.state === 'confirmed')
    return { ok: false, diagnostics: [diagnostic('incomplete', 'Confirmed decision is missing')] }
  if (
    decisionOperation !== null &&
    (decisionOperation.status !== 'incomplete' ||
      decisionOperation.parts.some((part) => commentAsPartPin(part) === null))
  )
    return { ok: false, diagnostics: [diagnostic('ambiguous', 'Observed decision reservation is not pinnable')] }
  return deriveUnconfirmedDecision(context, decisionIdentity, decisionOperation, publication)
}
