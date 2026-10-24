import type { Json } from '../dist/contracts.js'
import type { CorrectionExecution, CorrectionRevertResult } from './correction-execution-contract'
import {
  type AppliedAttempt,
  type CorrectionApplyAttempt,
  type CorrectionOutcome,
  contributionIds,
  correctionOutcome,
  type FailedRound,
  failureRaw,
  resultRaw,
  type SelectedAdmission,
  terminalOutcome,
} from './correction-policy-contract'
import type { CorrectionCause } from './fix-domain'

async function withdrawOptional(
  admission: SelectedAdmission,
  executor: CorrectionExecution,
  applied: AppliedAttempt,
  requiredCauses: readonly CorrectionCause[],
  attempt: 1 | 2,
  attempts: readonly CorrectionApplyAttempt[],
  falsification: NonNullable<CorrectionOutcome['falsification']>,
  actionContributionIds: string[],
): Promise<CorrectionOutcome> {
  const reverted = await executor.revert(applied.commitSHAs)
  actionContributionIds.push(...contributionIds(reverted))
  if (!reverted.ok)
    return terminalOutcome(
      admission,
      attempt,
      applied.commitSHAs,
      attempts,
      {
        apply: applied.raw,
        revert: failureRaw(reverted.diagnostics),
        reason: 'optional-withdrawal-unverified',
      },
      falsification,
      actionContributionIds,
    )
  const revalidated = await executor.revalidateRequiredPaths(requiredCauses)
  actionContributionIds.push(...contributionIds(revalidated))
  if (!revalidated.ok)
    return terminalOutcome(
      admission,
      attempt,
      applied.commitSHAs,
      attempts,
      {
        apply: applied.raw,
        revert: reverted.value,
        revalidation: failureRaw(revalidated.diagnostics),
        reason: 'required-path-revalidation-failed',
      },
      falsification,
      actionContributionIds,
    )
  return correctionOutcome(
    admission,
    attempt,
    'withdrawn',
    applied.commitSHAs,
    attempts,
    resultRaw(attempts, {
      apply: applied.raw,
      revert: reverted.value,
      revalidation: revalidated.value,
    }),
    falsification,
    actionContributionIds,
  )
}

export async function invalidCommitCardinalityOutcome(
  admission: SelectedAdmission,
  executor: CorrectionExecution,
  round: 1 | 2,
  current: AppliedAttempt,
  applyAttempts: readonly CorrectionApplyAttempt[],
  actionContributionIds: string[],
): Promise<CorrectionOutcome> {
  const reverted = await executor.revert(current.commitSHAs)
  actionContributionIds.push(...contributionIds(reverted))
  return terminalOutcome(
    admission,
    round,
    current.commitSHAs,
    applyAttempts,
    {
      apply: current.raw,
      revert: reverted.ok ? reverted.value : failureRaw(reverted.diagnostics),
      reason: 'correction-commit-cardinality-invalid',
    },
    null,
    actionContributionIds,
  )
}

export function unusableFalsificationOutcome(
  admission: SelectedAdmission,
  round: 1 | 2,
  current: AppliedAttempt,
  applyAttempts: readonly CorrectionApplyAttempt[],
  diagnostics: readonly string[],
  actionContributionIds: readonly string[],
): CorrectionOutcome {
  return terminalOutcome(
    admission,
    round,
    current.commitSHAs,
    applyAttempts,
    {
      apply: current.raw,
      falsification: failureRaw(diagnostics),
      reason: 'native-falsification-unusable',
    },
    null,
    actionContributionIds,
  )
}

type RetryAfterFalsificationFailure = { retry: true; reverted: CorrectionRevertResult }

export async function resolveFailedFalsification(
  admission: SelectedAdmission,
  executor: CorrectionExecution,
  current: AppliedAttempt,
  requiredCauses: readonly CorrectionCause[],
  round: 1 | 2,
  applyAttempts: readonly CorrectionApplyAttempt[],
  falsification: NonNullable<CorrectionOutcome['falsification']>,
  falsificationAttempts: readonly Json[],
  actionContributionIds: string[],
): Promise<CorrectionOutcome | RetryAfterFalsificationFailure> {
  if (!admission.required)
    return withdrawOptional(
      admission,
      executor,
      current,
      requiredCauses,
      round,
      applyAttempts,
      falsification,
      actionContributionIds,
    )
  const reverted = await executor.revert(current.commitSHAs)
  actionContributionIds.push(...contributionIds(reverted))
  if (!reverted.ok)
    return terminalOutcome(
      admission,
      round,
      current.commitSHAs,
      applyAttempts,
      {
        apply: current.raw,
        revert: failureRaw(reverted.diagnostics),
        reason: 'falsification-revert-unverified',
      },
      falsification,
      actionContributionIds,
    )
  if (round === 2)
    return correctionOutcome(
      admission,
      round,
      'reverted',
      current.commitSHAs,
      applyAttempts,
      resultRaw(applyAttempts, {
        apply: current.raw,
        revert: reverted.value,
        falsificationAttempts: [...falsificationAttempts],
      }),
      falsification,
      actionContributionIds,
    )
  return { retry: true, reverted: reverted.value }
}

export function resolveSecondRoundFailure(
  admission: SelectedAdmission,
  round: 2,
  secondRound: FailedRound,
  applyAttempts: readonly CorrectionApplyAttempt[],
  firstRound: {
    current: AppliedAttempt
    falsification: NonNullable<CorrectionOutcome['falsification']>
    reverted: CorrectionRevertResult
  },
  actionContributionIds: readonly string[],
): CorrectionOutcome {
  if (secondRound.terminal)
    return terminalOutcome(
      admission,
      round,
      [],
      applyAttempts,
      {
        firstRound: {
          apply: firstRound.current.raw,
          falsification: firstRound.falsification,
          revert: firstRound.reverted,
        },
        diagnostics: secondRound.diagnostics,
        reason: 'terminal-retry-apply-effect',
      },
      firstRound.falsification,
      actionContributionIds,
    )
  return correctionOutcome(
    admission,
    round,
    'failed',
    [],
    applyAttempts,
    resultRaw(applyAttempts, {
      firstRound: {
        apply: firstRound.current.raw,
        falsification: firstRound.falsification,
        revert: firstRound.reverted,
      },
      diagnostics: secondRound.diagnostics,
    }),
    firstRound.falsification,
    actionContributionIds,
  )
}
