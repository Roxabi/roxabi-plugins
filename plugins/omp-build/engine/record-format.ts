import { incompatibleFormat } from './record-diagnostics.ts'
import type { Diagnostic } from './record-values.ts'

export const REVIEW_INPUT_FORMAT = 'omp-build:review-input/3'

export const MANDATE_FORMAT = 'omp-build-mandate/2'

function incompatible(message: string): Diagnostic {
  return { code: incompatibleFormat, message }
}

/** Reject removed and unversioned record formats before canonical schema parsing. */
export function recordFormatDiagnostic(value: unknown): Diagnostic | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.kind === 'proof')
    return incompatible("Record kind 'proof' was removed in #902 and cannot authorize anything")
  if (record.kind === 'mandate') {
    const payload = record.payload
    if (
      payload === null ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      'proofPins' in payload ||
      (payload as Record<string, unknown>).format !== MANDATE_FORMAT
    ) {
      return incompatible(
        `Mandate format must be ${MANDATE_FORMAT}; pre-#902 mandates (proof pins) cannot authorize landing`,
      )
    }
  }
  if (
    (record.kind !== 'review-attempt' && record.kind !== 'review') ||
    record.payload === null ||
    typeof record.payload !== 'object'
  )
    return null
  const payload = record.payload as Record<string, unknown>
  const snapshot = payload.inputSnapshot
  if (
    snapshot !== null &&
    typeof snapshot === 'object' &&
    !Array.isArray(snapshot) &&
    ('semctxParts' in snapshot || 'assertledgerParts' in snapshot)
  ) {
    return incompatible(`Review input expects ${REVIEW_INPUT_FORMAT} without external producer parts`)
  }
  if (payload.inputFormat !== REVIEW_INPUT_FORMAT)
    return incompatible(`Review input format must be ${REVIEW_INPUT_FORMAT}`)
  return null
}
