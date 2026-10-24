import type { Json } from '../dist/contracts.js'
import type { CorrectionExecution } from './correction-execution-contract'
import type { CauseAdmission, CorrectionCause } from './fix-domain'

export type CorrectionOutcome = {
  cause: CorrectionCause
  /** Falsification round, never the apply retry count. */
  attempt: 1 | 2
  outcome: 'applied' | 'failed' | 'reverted' | 'withdrawn'
  /** Explicit binding for lifecycle publication; every outcome was actually started. */
  execution: { causeId: string; falsificationRound: 1 | 2; attempted: true }
  terminalFailure: boolean
  /** Typed terminal refusal before any actual correction effect; never persisted separately. */
  terminalDiagnostics: readonly string[] | null
  commitSHAs: string[]
  /** Original native action contributions, retained verbatim for receipt inputs. */
  sourceContributionIds: readonly string[]
  raw: Json
  applyAttempts: readonly CorrectionApplyAttempt[]
  falsification: { result: 'pass' | 'fail' | 'skipped'; raw: Json; notes: string } | null
}

export type CorrectionApplyAttempt = {
  round: 1 | 2
  attempt: 1 | 2 | 3
  result: 'applied' | 'failed' | 'terminal'
  raw: Json
  sourceContributionIds: readonly string[]
}

export type RetainedCorrectionObligation = {
  cause: CorrectionCause
  findingIds: readonly string[]
  diagnostics: readonly string[]
  source: 'admission' | 'outcome' | 'withheld'
}

export type CorrectionPlanResult = {
  ok: boolean
  outcomes: readonly CorrectionOutcome[]
  retainedObligations: readonly RetainedCorrectionObligation[]
  terminalDiagnostics: readonly string[] | null
  terminal: boolean
}

export type SelectedAdmission = Extract<CauseAdmission, { status: 'selected' }>
export type AppliedAttempt = { commitSHAs: string[]; raw: Json }
export type AppliedRound = { applied: AppliedAttempt; applyAttempts: CorrectionApplyAttempt[] }
export type FailedRound = {
  applyAttempts: CorrectionApplyAttempt[]
  terminal: boolean
  diagnostics: string[]
  preEffectRefusal: readonly string[] | null
}

export function failureRaw(diagnostics: readonly string[]): Json {
  return { diagnostics: [...diagnostics] }
}

/** Retain only observed native contribution IDs; no synthetic receipt input is created. */
export function contributionIds(effect: unknown): string[] {
  if (effect === null || typeof effect !== 'object' || Array.isArray(effect)) return []
  const result = effect as Record<string, unknown>
  const value =
    result.ok === true && result.value !== null && typeof result.value === 'object' && !Array.isArray(result.value)
      ? (result.value as Record<string, unknown>)
      : result
  const ids = value.contributionIds
  return Array.isArray(ids) && ids.every((id): id is string => typeof id === 'string' && id.length > 0)
    ? [...new Set(ids)]
    : []
}

export function resultRaw(attempts: readonly CorrectionApplyAttempt[], extra: Record<string, Json>): Json {
  return {
    applyAttempts: attempts.map((entry) => ({
      round: entry.round,
      attempt: entry.attempt,
      result: entry.result,
      raw: entry.raw,
      sourceContributionIds: [...entry.sourceContributionIds],
    })),
    ...extra,
  }
}

export function correctionOutcome(
  admission: SelectedAdmission,
  attempt: 1 | 2,
  state: CorrectionOutcome['outcome'],
  commitSHAs: readonly string[],
  applyAttempts: readonly CorrectionApplyAttempt[],
  raw: Json,
  falsification: CorrectionOutcome['falsification'],
  actionContributionIds: readonly string[] = [],
): CorrectionOutcome {
  return {
    cause: admission.cause,
    attempt,
    outcome: state,
    terminalDiagnostics: null,
    execution: { causeId: admission.cause.id, falsificationRound: attempt, attempted: true },
    terminalFailure: false,
    commitSHAs: [...commitSHAs],
    sourceContributionIds: [
      ...new Set([...applyAttempts.flatMap((entry) => entry.sourceContributionIds), ...actionContributionIds]),
    ],
    raw,
    applyAttempts: [...applyAttempts],
    falsification,
  }
}

export function terminalOutcome(
  admission: SelectedAdmission,
  attempt: 1 | 2,
  commitSHAs: readonly string[],
  attempts: readonly CorrectionApplyAttempt[],
  raw: Record<string, Json>,
  falsification: CorrectionOutcome['falsification'] = null,
  actionContributionIds: readonly string[] = [],
  terminalDiagnostics: readonly string[] | null = null,
): CorrectionOutcome {
  return {
    ...correctionOutcome(
      admission,
      attempt,
      'failed',
      commitSHAs,
      attempts,
      resultRaw(attempts, { ...raw, effectsCleanup: 'unproven' }),
      falsification,
      actionContributionIds,
    ),
    terminalFailure: true,
    terminalDiagnostics: terminalDiagnostics === null ? null : [...terminalDiagnostics],
  }
}

export type CorrectionExecutor = CorrectionExecution
