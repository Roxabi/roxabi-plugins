import { incompatibleFormat } from './record-diagnostics.ts'
import type { Diagnostic } from './record-values.ts'

export const REVIEW_INPUT_FORMAT = 'omp-build:review-input/3'

export const MANDATE_FORMAT = 'omp-build-mandate/3'

function incompatible(message: string): Diagnostic {
  return { code: incompatibleFormat, message }
}

function mandateFormatDiagnostic(record: Record<string, unknown>): Diagnostic | null {
  if (record.kind !== 'mandate') return null
  const payload = record.payload
  if (
    payload === null ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    'proofPins' in payload ||
    (payload as Record<string, unknown>).format !== MANDATE_FORMAT
  )
    return incompatible(
      `Mandate format must be ${MANDATE_FORMAT} with ownSpec, tier and children; pre-#897 mandates cannot authorize workflow`,
    )
  return null
}

function materialAcceptanceFormatDiagnostic(record: Record<string, unknown>): Diagnostic | null {
  const payload = record.payload
  if (
    record.kind !== 'operator-control' ||
    payload === null ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    !('control' in payload)
  )
    return null
  const control = payload as Record<string, unknown>
  if (control.control !== 'accept-material') return null
  if (
    !('specVersion' in control) ||
    !('proposalDigest' in control) ||
    !('confirmation' in control) ||
    !('identityDelta' in control)
  )
    return incompatible('Material acceptance must use the #897 exact Spec control shape')
  return null
}

function assessmentFormatDiagnostic(record: Record<string, unknown>): Diagnostic | null {
  const payload = record.payload
  if (record.kind !== 'action-receipt' || payload === null || typeof payload !== 'object' || Array.isArray(payload))
    return null
  const receipt = payload as Record<string, unknown>
  if (receipt.action !== 'assess-spec') return null
  const exactInputs = receipt.exactInputs
  if (
    exactInputs === null ||
    typeof exactInputs !== 'object' ||
    Array.isArray(exactInputs) ||
    (exactInputs as Record<string, unknown>).format !== 'omp-build-spec-assessment/2'
  )
    return incompatible('Spec assessment must use omp-build-spec-assessment/2 exact state')
  return null
}

function reviewFormatDiagnostic(record: Record<string, unknown>): Diagnostic | null {
  if (record.kind !== 'review-attempt' && record.kind !== 'review') return null
  const payload = record.payload
  if (payload === null || typeof payload !== 'object') return null
  const review = payload as Record<string, unknown>
  const snapshot = review.inputSnapshot
  if (
    snapshot !== null &&
    typeof snapshot === 'object' &&
    !Array.isArray(snapshot) &&
    ('semctxParts' in snapshot || 'assertledgerParts' in snapshot)
  )
    return incompatible(`Review input expects ${REVIEW_INPUT_FORMAT} without external producer parts`)
  return review.inputFormat === REVIEW_INPUT_FORMAT
    ? null
    : incompatible(`Review input format must be ${REVIEW_INPUT_FORMAT}`)
}

/** Reject removed and unversioned record formats before canonical schema parsing. */
export function recordFormatDiagnostic(value: unknown): Diagnostic | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.kind === 'proof')
    return incompatible("Record kind 'proof' was removed in #902 and cannot authorize anything")
  return (
    mandateFormatDiagnostic(record) ??
    materialAcceptanceFormatDiagnostic(record) ??
    assessmentFormatDiagnostic(record) ??
    reviewFormatDiagnostic(record)
  )
}
