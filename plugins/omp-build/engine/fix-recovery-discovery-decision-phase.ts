import { originalDecisionMatches } from './correction-request-basis.ts'
import { completeTrustedRecords, type OpenedRecord, pinForComplete } from './fix-recovery-discovery-records.ts'
import type { PartPin, ReservedRecordIdentity } from './fix-recovery-identities.ts'
import { commentAsPartPin, observedPartsMatch } from './fix-recovery-part-pins.ts'
import type { InterruptedPhase, OutboundOperation } from './fix-recovery-phase-schema.ts'
import type { OpenedRef } from './fix-recovery-schema.ts'
import type { DecodedHistory, OperationRead } from './history-schema.ts'
import { diagnostic, equalScope } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic } from './record-values.ts'

export type PhaseResult = { ok: true; value: InterruptedPhase } | { ok: false; diagnostics: Diagnostic[] }
export type AuthenticatedRequest = {
  sourceRecord: Extract<CanonicalRecord, { kind: 'contribution' }>
  requestRecord: Extract<CanonicalRecord, { kind: 'fix-request' }>
  sourceOperation: OperationRead
  requestOperation: OperationRead
  requestHome: DecodedHistory
  rootBasis: { value: { originalCandidate: string } }
  opening: OpenedRecord
  outbound: readonly OutboundOperation[]
  histories: readonly DecodedHistory[]
  opened: OpenedRef
  intent: Extract<OpenedRecord['payload']['intent'], { kind: 'fresh-intake' }>
}

export function phaseFailure(code: string, message: string): PhaseResult {
  return { ok: false, diagnostics: [diagnostic(code, message)] }
}

export function deriveUnreservedDecision({
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
  const untracked = completeTrustedRecords(histories).some(
    (record) =>
      record.kind === 'decision' &&
      equalScope(record, requestRecord) &&
      record.payload.judgment.purpose === 'correction' &&
      originalDecisionMatches(requestHome, requestRecord, record, rootBasis.value.originalCandidate),
  )
  if (untracked) return phaseFailure('ambiguous', 'An unreserved complete decision exists for this request')
  return {
    ok: true,
    value: {
      kind: 'request-before-decision',
      opened,
      source: pinForComplete(intent.sourceReservation, sourceRecord, sourceOperation),
      request: pinForComplete(intent.requestReservation, requestRecord, requestOperation),
      decision: { state: 'not-reserved' },
    },
  }
}

export function deriveUnconfirmedDecision(
  { sourceRecord, requestRecord, sourceOperation, requestOperation, opened, intent }: AuthenticatedRequest,
  decisionIdentity: ReservedRecordIdentity<'decision'>,
  decisionOperation: OperationRead | null,
  publication: Exclude<OutboundOperation['publication'], { state: 'confirmed' }>,
): PhaseResult {
  if (publication.state === 'reserved') {
    return {
      ok: true,
      value: {
        kind: 'request-before-decision',
        opened,
        source: pinForComplete(intent.sourceReservation, sourceRecord, sourceOperation),
        request: pinForComplete(intent.requestReservation, requestRecord, requestOperation),
        decision:
          decisionOperation === null
            ? { state: 'not-submitted', reservation: decisionIdentity }
            : {
                state: 'submitted-unconfirmed',
                reservation: decisionIdentity,
                observedParts: decisionOperation.parts
                  .map(commentAsPartPin)
                  .filter((part): part is PartPin => part !== null),
              },
      },
    }
  }
  if (
    (decisionOperation === null && publication.observedParts.length !== 0) ||
    (decisionOperation !== null &&
      (decisionOperation.status !== 'incomplete' ||
        !observedPartsMatch(publication.observedParts, decisionOperation, false)))
  )
    return phaseFailure('incomplete', 'Unconfirmed decision parts do not match the settled pin')
  return {
    ok: true,
    value: {
      kind: 'request-before-decision',
      opened,
      source: pinForComplete(intent.sourceReservation, sourceRecord, sourceOperation),
      request: pinForComplete(intent.requestReservation, requestRecord, requestOperation),
      decision: {
        state: 'submitted-unconfirmed',
        reservation: decisionIdentity,
        observedParts:
          decisionOperation === null
            ? []
            : decisionOperation.parts.map(commentAsPartPin).filter((part): part is PartPin => part !== null),
      },
    },
  }
}
