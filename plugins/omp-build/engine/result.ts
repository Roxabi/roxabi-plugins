import type { DecodedHistory } from './history-schema.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic, Group, Json, Label, Scope, Verdict } from './record-values.ts'
import type { Stop } from './review-schema.ts'

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; diagnostics: Diagnostic[]; knownReviews?: number; countExact?: boolean; spent?: boolean | null }

export type FindingInspection = { usable: boolean; knownLabel: Label | null; diagnostics: Diagnostic[] }
export type DecisionAssessment = {
  admissible: boolean
  groups: Record<Group, string[]>
  verdict: Verdict | null
  findings: { id: string; inspection: FindingInspection }[]
  diagnostics: Diagnostic[]
}
export type ReviewFacts = Scope & {
  candidateGitSHA: string
  input: string | null
  proofAdmission: Result<Json>
  ci: 'green' | 'red' | 'pending' | 'unknown'
  acceptedEvidencePolicyRef: string | null
}
export type ReviewSummary = {
  reviews: number
  reviewId: string | null
  verdict: Verdict | null
  head: string | null
  input: string | null
  at: string | null
  spent: boolean
}
export type ReviewState =
  | { ok: true; summary: ReviewSummary; next: 'review' | 'fix' | 'admit' | 'wait' | 'stop'; requiredStop: Stop | null }
  | {
      ok: false
      next: 'stop'
      knownReviews: number
      countExact: boolean
      spent: boolean | null
      diagnostics: Diagnostic[]
    }

export type RecordProjectionConfig = {
  taxonomy: readonly string[]
  acceptedPolicy: string | null
}

export const diagnostic = (code: string, message: string, detail?: Json): Diagnostic =>
  detail === undefined ? { code, message } : { code, message, detail }
export const fail = <T>(
  diagnostics: Diagnostic[],
  metadata: Omit<Extract<Result<T>, { ok: false }>, 'ok' | 'diagnostics'> = {},
): Result<T> => ({ ok: false, diagnostics, ...metadata })
export function equalScope(left: Scope, right: Scope): boolean {
  return left.repository === right.repository && left.target === right.target
}
export const unique = (values: readonly string[]): boolean => new Set(values).size === values.length
export const recordMap = (history: DecodedHistory): Map<string, CanonicalRecord> => {
  const records = new Map<string, CanonicalRecord>()
  for (const operation of history.operations) {
    if (operation.status === 'complete' && operation.record !== null && !records.has(operation.record.recordId))
      records.set(operation.record.recordId, operation.record)
  }
  return records
}
