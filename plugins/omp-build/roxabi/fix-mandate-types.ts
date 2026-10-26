import type { CanonicalRecord, DecodedHistory, GitHubOptions, Scope } from '../dist/contracts.js'
import type { FixActionResult, FixTarget, ReviewAuthority, ReviewStepResult } from './fix-contract.ts'
import { failure } from './fix-contract.ts'

export const MANDATE_REFUSAL: Record<string, true> = {
  paused: true,
  abandoned: true,
  revoked: true,
  unsupported: true,
  'config-invalid': true,
  'config-drift': true,
  ambiguous: true,
  incomplete: true,
  unconfirmed: true,
  'unknown-binding': true,
  incompatible: true,
  unsafe: true,
  'materially-changed': true,
  missing: true,
  'missing-history': true,
  'material-spec': true,
  'fix-only': true,
  stale: true,
  foreign: true,
  unbound: true,
  conflict: true,
}

export const FIX_OPERATION_KIND: Record<string, true> = {
  'fix-request': true,
  'fix-result': true,
  'correction-result': true,
  'falsification-result': true,
  'debt-receipt': true,
}

export type FixCheckpoint =
  | { status: 'not-started' }
  | { status: 'complete'; requestId: string; resultId: string; candidateGitSHA: string }
  | { status: 'live-owned'; requestId: string }
  | {
      status: 'blocked'
      reason: 'unresolved-effect' | 'ambiguous' | 'conflict' | 'incomplete-history'
      diagnostics: string[]
      startedRequestIds: string[]
    }

export type FixMandateView = {
  recordId: string
  role: 'feature' | 'epic' | 'fix-only'
  storedLanding: boolean
  repository: string
  target: string
  specBody: string | null
  parent: { scope: Scope; recordId: string; kind: string } | null
  antecedent: { scope: Scope; recordId: string; kind: string } | null
}

export type CorrectionExecutionRights = { correct: true; landing: false }

export type CiCorrectionStepClass =
  | {
      readonly status: 'attributed-correction'
      readonly action: 'fix'
      readonly reason: 'ci-failed'
      readonly reviews?: number
      readonly remaining?: number
    }
  | {
      readonly status: 'spent'
      readonly action: 'stop'
      readonly reason: 'ci-failed' | 'review-bound'
      readonly reviews?: number
    }
  | { readonly status: 'unsafe'; readonly reason: string; readonly reviews?: number }
  | { readonly status: 'refused'; readonly action: 'fix' | 'review' | 'land' | 'stop'; readonly reason?: string }

export type CiCorrectionAdmission = {
  readonly status: 'attributed-correction'
  readonly action: 'fix'
  readonly reason: 'ci-failed'
  readonly reviews?: number
  readonly remaining?: number
  readonly attributionRecordId: string
  readonly candidateGitSHA: string
  readonly scope: string
  readonly mandateRecordId: string
  readonly failedChecks: readonly string[]
}

export type CiCorrectionBound =
  | CiCorrectionAdmission
  | Exclude<CiCorrectionStepClass, { status: 'attributed-correction' }>

/** Uses the step nextReviewStep already returned. Does not count rounds or read attribution. */
export function classifyCiCorrectionStep(step: ReviewStepResult): CiCorrectionStepClass {
  if (step.action === 'fix' && step.reason === 'ci-failed') {
    return {
      status: 'attributed-correction',
      action: 'fix',
      reason: 'ci-failed',
      reviews: step.reviews,
      remaining: step.remaining,
    }
  }
  if (step.action === 'stop' && (step.reason === 'ci-failed' || step.reason === 'review-bound')) {
    return { status: 'spent', action: 'stop', reason: step.reason, reviews: step.reviews }
  }
  if (step.action === 'stop' && (step.reason === 'unsafe' || step.reason === 'head-unapproved')) {
    return { status: 'unsafe', reason: step.reason, reviews: step.reviews }
  }
  return { status: 'refused', action: step.action, reason: step.reason }
}

export type AttributedCiCorrectionInput = {
  cwd: string
  target: FixTarget
  scope: string
  branch: string | null
  base: string | null
  attributionRecordId: string
  workflow: ReviewAuthority
  options: GitHubOptions
  readHistory: () => Promise<DecodedHistory>
  signal?: AbortSignal
}

export function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function diagnosticCodes(evidence: unknown): string[] {
  if (!Array.isArray(evidence)) return ['fix-mandate-evidence-unreadable']
  return evidence.map((item) => {
    const record = objectValue(item)
    return record !== null && typeof record.code === 'string' && record.code.length > 0
      ? record.code
      : 'fix-mandate-evidence-unreadable'
  })
}

export function completeRecord(history: DecodedHistory, recordId: string): CanonicalRecord | null {
  const matches = history.operations.filter(
    (operation) => operation.status === 'complete' && operation.record?.recordId === recordId,
  )
  return matches.length === 1 ? (matches[0]?.record ?? null) : null
}

export function mandateView(record: CanonicalRecord): FixActionResult<FixMandateView> {
  const payload = objectValue(record.payload)
  const permissions = objectValue(payload?.permissions)
  const role = payload?.role
  if (
    payload === null ||
    permissions === null ||
    (role !== 'feature' && role !== 'epic' && role !== 'fix-only') ||
    typeof permissions.landing !== 'boolean' ||
    permissions.correct !== true
  ) {
    return failure('fix-mandate-unrecognized')
  }
  if (role === 'fix-only' && permissions.landing !== false) return failure('fix-mandate-lands')
  const spec = objectValue(payload.spec)
  const parent = externalRef(payload.parent)
  const antecedent = externalRef(payload.antecedent)
  if (payload.parent !== null && parent === null) return failure('fix-mandate-parent-unreadable')
  if (payload.antecedent !== null && antecedent === null) return failure('fix-mandate-antecedent-unreadable')
  return {
    ok: true,
    value: {
      recordId: record.recordId,
      role,
      storedLanding: permissions.landing,
      repository: record.repository,
      target: record.target,
      specBody: spec !== null && typeof spec.body === 'string' ? spec.body : null,
      parent,
      antecedent,
    },
  }
}

export function externalRef(value: unknown): { scope: Scope; recordId: string; kind: string } | null {
  const record = objectValue(value)
  const scope = objectValue(record?.scope)
  if (
    record === null ||
    scope === null ||
    typeof scope.repository !== 'string' ||
    typeof scope.target !== 'string' ||
    typeof record.recordId !== 'string' ||
    typeof record.kind !== 'string'
  ) {
    return null
  }
  return { scope: { repository: scope.repository, target: scope.target }, recordId: record.recordId, kind: record.kind }
}
