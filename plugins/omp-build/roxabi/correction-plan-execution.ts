import type { Json } from '../dist/contracts.js'
import type { CorrectionExecution } from './correction-execution-contract'
import {
  invalidCommitCardinalityOutcome,
  resolveFailedFalsification,
  resolveSecondRoundFailure,
  unusableFalsificationOutcome,
} from './correction-plan-execution-outcomes'
import { resolveFirstRoundFailure } from './correction-plan-first-round'
import {
  type AppliedRound,
  type CorrectionApplyAttempt,
  type CorrectionOutcome,
  contributionIds,
  correctionOutcome,
  type FailedRound,
  failureRaw,
  resultRaw,
  type SelectedAdmission,
} from './correction-policy-contract'
import { assessFalsification, type CorrectionCause } from './fix-domain'

async function applyRound(
  admission: SelectedAdmission,
  executor: CorrectionExecution,
  round: 1 | 2,
): Promise<AppliedRound | FailedRound> {
  const allowedAttempts = admission.required ? ([1, 2, 3] as const) : ([1] as const)
  const attempts: CorrectionApplyAttempt[] = []
  for (const attempt of allowedAttempts) {
    const applied = await executor.apply(admission.cause, attempt)
    if (applied.ok) {
      attempts.push({
        round,
        attempt,
        result: 'applied',
        raw: applied.value.raw,
        sourceContributionIds: contributionIds(applied),
      })
      return { applied: applied.value, applyAttempts: attempts }
    }
    const terminal = applied.kind === 'terminal'
    attempts.push({
      round,
      attempt,
      result: terminal ? 'terminal' : 'failed',
      raw: failureRaw(applied.diagnostics),
      sourceContributionIds: contributionIds(applied),
    })
    if (terminal)
      return {
        applyAttempts: attempts,
        terminal: true,
        diagnostics: applied.diagnostics,
        preEffectRefusal: applied.preEffectRefusal === undefined ? null : [...applied.preEffectRefusal],
      }
  }
  return {
    applyAttempts: attempts,
    terminal: false,
    diagnostics: [admission.required ? 'correction-apply-failed-after-3' : 'optional-apply-failed'],
    preEffectRefusal: null,
  }
}

/** Apply retries (three) stay independent from two falsification rounds. */
export async function executeCorrection(
  admission: SelectedAdmission,
  executor: CorrectionExecution,
  requiredCauses: readonly CorrectionCause[] = [],
): Promise<CorrectionOutcome> {
  const firstRound = await applyRound(admission, executor, 1)
  if (!('applied' in firstRound)) return resolveFirstRoundFailure(admission, executor, requiredCauses, firstRound)

  let round: 1 | 2 = 1
  let current = firstRound.applied
  let applyAttempts = firstRound.applyAttempts
  const falsificationAttempts: Json[] = []
  const actionContributionIds: string[] = []
  while (true) {
    if (current.commitSHAs.length !== 1)
      return invalidCommitCardinalityOutcome(admission, executor, round, current, applyAttempts, actionContributionIds)
    const proof = await executor.falsify(admission.cause, current.commitSHAs)
    actionContributionIds.push(...contributionIds(proof))
    if (!proof.ok)
      return unusableFalsificationOutcome(
        admission,
        round,
        current,
        applyAttempts,
        proof.diagnostics,
        actionContributionIds,
      )
    const assessment = assessFalsification(proof.value.facts, proof.value.skippedReason)
    const falsification = { result: assessment.result, raw: proof.value.raw, notes: assessment.notes }
    falsificationAttempts.push({ round, result: assessment.result, notes: assessment.notes, raw: proof.value.raw })
    if (assessment.result !== 'fail')
      return correctionOutcome(
        admission,
        round,
        'applied',
        current.commitSHAs,
        applyAttempts,
        resultRaw(applyAttempts, {
          apply: current.raw,
          falsificationAttempts,
        }),
        falsification,
        actionContributionIds,
      )
    const failedFalsification = await resolveFailedFalsification(
      admission,
      executor,
      current,
      requiredCauses,
      round,
      applyAttempts,
      falsification,
      falsificationAttempts,
      actionContributionIds,
    )
    if (!('retry' in failedFalsification)) return failedFalsification
    round = 2
    const secondRound = await applyRound(admission, executor, round)
    applyAttempts = [...applyAttempts, ...secondRound.applyAttempts]
    if (!('applied' in secondRound))
      return resolveSecondRoundFailure(
        admission,
        round,
        secondRound,
        applyAttempts,
        { current, falsification, reverted: failedFalsification.reverted },
        actionContributionIds,
      )
    current = secondRound.applied
  }
}
