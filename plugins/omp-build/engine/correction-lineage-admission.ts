import { citedOperationIntegrity } from './delivery-eligibility.ts'
import type { DecodedHistory } from './history-schema.ts'
import type { CanonicalRecord } from './record-schema.ts'
import { bindExternalRef, historyFor } from './workflow-control.ts'

type Fix = Extract<CanonicalRecord, { kind: 'fix-result' }>
type Correction = Extract<CanonicalRecord, { kind: 'correction-result' }>
type Falsification = Extract<CanonicalRecord, { kind: 'falsification-result' }>

export function correctionRecord<K extends CanonicalRecord['kind']>(
  fix: Fix,
  histories: readonly DecodedHistory[],
  id: string,
  kind: K,
): Extract<CanonicalRecord, { kind: K }> | null {
  const scope = { repository: fix.repository, target: fix.target }
  const history = historyFor(scope, histories)
  if (history === null || citedOperationIntegrity(history, id) !== null) return null
  const result = bindExternalRef({ scope, recordId: id, kind }, history)
  return result.ok && result.value.kind === kind ? (result.value as Extract<CanonicalRecord, { kind: K }>) : null
}

export function correctionObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function admitCorrectionLineage(
  fix: Fix,
  histories: readonly DecodedHistory[],
  decisionId: string,
  causeId: string,
): {
  correction: Correction
  corrections: Correction[]
  falsifications: Falsification[]
  raw: Record<string, unknown>
  appliedId: string
} | null {
  const corrections = fix.payload.correctionResultIds.map((id) =>
    correctionRecord(fix, histories, id, 'correction-result'),
  )
  if (
    corrections.some((item) => item === null) ||
    fix.payload.correctionResultIds.some((id) => !fix.inputs.includes(id))
  )
    return null
  const validCorrections = corrections.filter((item): item is Correction => item !== null)
  if (
    validCorrections.some((item) => {
      const raw = correctionObject(item.payload.raw)
      return raw?.terminalFailure !== false || raw.effectsCleanup !== 'not-required'
    })
  )
    return null
  const matching = validCorrections.filter(
    (item) => item.payload.decisionId === decisionId && item.payload.causeId === causeId,
  )
  const correction = matching[0]
  if (matching.length !== 1 || correction?.payload.outcome !== 'applied') return null
  const falsifications = fix.payload.falsificationResultIds.map((id) =>
    correctionRecord(fix, histories, id, 'falsification-result'),
  )
  if (
    falsifications.some((item) => item === null) ||
    fix.payload.falsificationResultIds.some((id) => !fix.inputs.includes(id))
  )
    return null
  const validFalsifications = falsifications.filter((item): item is Falsification => item !== null)
  if (
    validFalsifications.some(
      (item) => item.payload.correctionResultId === correction.recordId && item.payload.result === 'fail',
    )
  )
    return null
  const payload = correction.payload
  const raw = correctionObject(payload.raw)
  const execution = correctionObject(raw?.execution)
  if (
    !correction.inputs.includes(decisionId) ||
    raw?.terminalFailure !== false ||
    raw.effectsCleanup !== 'not-required' ||
    execution?.causeId !== payload.causeId ||
    execution.falsificationRound !== payload.attempt ||
    execution.attempted !== true
  )
    return null
  const appliedId = payload.appliedContributionId
  if (
    appliedId === null ||
    appliedId === undefined ||
    payload.commitSHAs.length !== 1 ||
    !correction.inputs.includes(appliedId)
  )
    return null
  return { correction, corrections: validCorrections, falsifications: validFalsifications, raw, appliedId }
}

export function finalApplyAttempt(raw: Record<string, unknown>, round: number, appliedId: string): boolean {
  const attempts = Array.isArray(raw.applyAttempts)
    ? raw.applyAttempts
        .map(correctionObject)
        .filter((item): item is Record<string, unknown> => item !== null && item.round === round)
    : []
  const last = attempts.at(-1)
  return (
    last?.result === 'applied' &&
    Array.isArray(last.sourceContributionIds) &&
    last.sourceContributionIds.includes(appliedId)
  )
}
