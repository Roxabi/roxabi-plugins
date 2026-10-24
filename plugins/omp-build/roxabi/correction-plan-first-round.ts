import type { CorrectionExecution } from './correction-execution-contract'
import {
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

/** Resolves a failed first application before any correction effect can be falsified. */
export async function resolveFirstRoundFailure(
  admission: SelectedAdmission,
  executor: CorrectionExecution,
  requiredCauses: readonly CorrectionCause[],
  firstRound: FailedRound,
): Promise<CorrectionOutcome> {
  if (!admission.required && !firstRound.terminal) {
    const revalidated = await executor.revalidateRequiredPaths(requiredCauses)
    const actionContributionIds = contributionIds(revalidated)
    if (!revalidated.ok) {
      return terminalOutcome(
        admission,
        1,
        [],
        firstRound.applyAttempts,
        {
          diagnostics: firstRound.diagnostics,
          revalidation: failureRaw(revalidated.diagnostics),
          reason: 'optional-apply-failure-required-path-revalidation-failed',
        },
        null,
        actionContributionIds,
      )
    }
    return correctionOutcome(
      admission,
      1,
      'failed',
      [],
      firstRound.applyAttempts,
      resultRaw(firstRound.applyAttempts, {
        diagnostics: firstRound.diagnostics,
        revalidation: revalidated.value,
      }),
      null,
      actionContributionIds,
    )
  }
  if (firstRound.terminal) {
    return terminalOutcome(
      admission,
      1,
      [],
      firstRound.applyAttempts,
      {
        diagnostics: firstRound.diagnostics,
        reason: 'terminal-apply-effect',
      },
      null,
      [],
      firstRound.preEffectRefusal,
    )
  }
  return correctionOutcome(
    admission,
    1,
    'failed',
    [],
    firstRound.applyAttempts,
    resultRaw(firstRound.applyAttempts, {
      diagnostics: firstRound.diagnostics,
    }),
    null,
  )
}
