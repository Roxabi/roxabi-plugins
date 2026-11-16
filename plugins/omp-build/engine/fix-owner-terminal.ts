import { canonicalValueDigest } from './action-input.ts'
import { originalDecisionMatches, resolveCorrectionRootBasis } from './correction-request-basis.ts'
import { matchesCompletePin } from './fix-recovery-discovery-records.ts'
import { commentAsPartPin, partPinsEqual } from './fix-recovery-part-pins.ts'
import type { DecodedHistory, OperationRead } from './history-schema.ts'
import { equalScope } from './record-diagnostics.ts'
import { recordIntegrity } from './record-integrity.ts'
import type { CanonicalRecord } from './record-schema.ts'
import { bindExternalRef } from './workflow-control.ts'

type Owner = Extract<CanonicalRecord, { kind: 'fix-owner' }>

/** An authenticated ordinary terminal closes logical ownership, not a process lifetime. */
export function hasAuthenticatedOrdinaryFixTerminal(opening: Owner, histories: readonly DecodedHistory[]): boolean {
  if (opening.payload.phase !== 'opened') return false
  const intent = opening.payload.intent
  const requestIdentity = intent.kind === 'fresh-intake' ? intent.requestReservation : intent.request.identity
  if (
    intent.kind === 'resume-decision' &&
    (!matchesCompletePin(histories, intent.source) ||
      !matchesCompletePin(histories, intent.request) ||
      !matchesCompletePin(histories, intent.decision))
  )
    return false
  const sources = histories.filter((history) => equalScope(history.source.scope, requestIdentity.scope))
  const source = sources[0]
  if (sources.length !== 1 || source === undefined || !source.source.complete) return false
  const resolve = (
    kind: CanonicalRecord['kind'],
    id: string,
    history: DecodedHistory = source,
  ): CanonicalRecord | null => resolveAuthenticatedRecord(history, kind, id)
  const request = resolve('fix-request', requestIdentity.recordId)
  if (
    request?.kind !== 'fix-request' ||
    request.runId !== requestIdentity.runId ||
    request.operationId !== requestIdentity.operationId ||
    !equalScope(request, requestIdentity.scope)
  )
    return false
  const contributionIdentity = intent.kind === 'fresh-intake' ? intent.sourceReservation : intent.source.identity
  const contribution = resolve('contribution', contributionIdentity.recordId)
  if (
    contribution?.kind !== 'contribution' ||
    contribution.runId !== contributionIdentity.runId ||
    contribution.operationId !== contributionIdentity.operationId ||
    !equalScope(contribution, contributionIdentity.scope) ||
    request.payload.requestContributionId !== contribution.recordId ||
    !request.inputs.includes(contribution.recordId)
  )
    return false
  return validTerminalResult(source, request, requestIdentity.runId, intent, histories, resolve)
}

type Resolver = (kind: CanonicalRecord['kind'], id: string, history?: DecodedHistory) => CanonicalRecord | null
type FixResult = Extract<CanonicalRecord, { kind: 'fix-result' }>
type Decision = Extract<CanonicalRecord, { kind: 'decision' }>

function validTerminalResult(
  source: DecodedHistory,
  request: Extract<CanonicalRecord, { kind: 'fix-request' }>,
  runId: string,
  intent: Extract<Owner['payload'], { phase: 'opened' }>['intent'],
  histories: readonly DecodedHistory[],
  resolve: Resolver,
): boolean {
  const basis = resolveCorrectionRootBasis(source, request)
  if (!basis.ok) return false
  const candidates = source.operations.filter(
    (operation) =>
      operation.authority !== 'foreign' &&
      operation.record?.kind === 'fix-result' &&
      operation.record.runId === runId &&
      operation.record.payload.requestId === request.recordId,
  )
  const candidate = candidates[0]
  if (candidates.length !== 1 || candidate?.record?.kind !== 'fix-result') return false
  const result = resolve('fix-result', candidate.record.recordId)
  if (
    result?.kind !== 'fix-result' ||
    result.runId !== runId ||
    !result.inputs.includes(request.recordId) ||
    !result.inputs.includes(result.payload.decisionId)
  )
    return false
  const decision = resolve('decision', result.payload.decisionId)
  if (
    decision?.kind !== 'decision' ||
    !originalDecisionMatches(source, request, decision, basis.value.originalCandidate)
  )
    return false
  if (
    intent.kind === 'resume-decision' &&
    (result.payload.decisionId !== intent.decision.identity.recordId ||
      !equalScope(intent.decision.identity.scope, source.source.scope))
  )
    return false
  if (!validCorrectionResults(result, decision, resolve)) return false
  if (!validFalsificationResults(result, resolve)) return false
  return validDispositions(result, source, histories, resolve)
}

function resolveAuthenticatedRecord(
  history: DecodedHistory,
  kind: CanonicalRecord['kind'],
  id: string,
): CanonicalRecord | null {
  const matches = history.operations.filter((entry) => entry.authority !== 'foreign' && entry.recordId === id)
  const operation: OperationRead | undefined = matches[0]
  const record = operation?.record
  if (
    matches.length !== 1 ||
    operation === undefined ||
    operation.status !== 'complete' ||
    record == null ||
    record.kind !== kind ||
    recordIntegrity(operation.parts, record) !== null ||
    !uniqueRawParts(history, operation)
  )
    return null
  const bound = bindExternalRef({ scope: history.source.scope, kind, recordId: id }, history)
  return bound.ok && canonicalValueDigest(bound.value) === canonicalValueDigest(record) ? record : null
}

function uniqueRawParts(history: DecodedHistory, operation: OperationRead): boolean {
  return operation.parts.every((part) => {
    const pin = commentAsPartPin(part)
    return (
      pin !== null &&
      history.source.comments.filter((comment) => {
        const observed = commentAsPartPin(comment)
        return observed !== null && partPinsEqual(pin, observed)
      }).length === 1
    )
  })
}

function validCorrectionResults(result: FixResult, decision: Decision, resolve: Resolver): boolean {
  for (const id of result.payload.correctionResultIds) {
    const correction = resolve('correction-result', id)
    if (
      !result.inputs.includes(id) ||
      correction?.kind !== 'correction-result' ||
      correction.payload.decisionId !== decision.recordId ||
      !correction.inputs.includes(decision.recordId) ||
      !decision.payload.judgment.causes.some((cause) => cause.id === correction.payload.causeId)
    )
      return false
  }
  return true
}

function validFalsificationResults(result: FixResult, resolve: Resolver): boolean {
  for (const id of result.payload.falsificationResultIds) {
    const falsification = resolve('falsification-result', id)
    if (
      !result.inputs.includes(id) ||
      falsification?.kind !== 'falsification-result' ||
      !result.payload.correctionResultIds.includes(falsification.payload.correctionResultId) ||
      !falsification.inputs.includes(falsification.payload.correctionResultId)
    )
      return false
  }
  return true
}

function validDispositions(
  result: FixResult,
  source: DecodedHistory,
  histories: readonly DecodedHistory[],
  resolve: Resolver,
): boolean {
  for (const ref of result.payload.causeDispositionRefs) {
    if (equalScope(ref.scope, source.source.scope)) {
      if (!result.inputs.includes(ref.recordId) || resolve('cause-disposition', ref.recordId) === null) return false
    } else {
      const homes = histories.filter((history) => equalScope(history.source.scope, ref.scope))
      const home = homes[0]
      if (
        homes.length !== 1 ||
        home === undefined ||
        !home.source.complete ||
        resolve('cause-disposition', ref.recordId, home) === null
      )
        return false
    }
  }
  return true
}
