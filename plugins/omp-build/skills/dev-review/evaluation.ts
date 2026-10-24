import type { BatchEvaluationOutcome } from './evaluation-batch'
import { drainBatch } from './evaluation-batch'
import type { EvaluationDependencies, FindingEvaluation, FindingEvidence, JudgmentBatch } from './evaluation-contract'
import { degraded, errorText, untouched } from './evaluation-normalize'
import { EVALUATION_OPTIONS, FINDING_DIMENSION_QUESTIONS } from './evaluation-questions'

/**
 * Evaluates evidence dimensions through the injected OMP Eval `judgeBatch` seam.
 * Returned observations are advisory only: this module never produces a review
 * disposition, patch permission, or merge authorization.
 */
export async function evaluateFindings(
  evidenceById: Record<string, FindingEvidence>,
  { judgeBatch }: EvaluationDependencies,
): Promise<Record<string, FindingEvaluation>> {
  const ids = Object.keys(evidenceById)
  if (ids.length === 0) return {}

  let batch: JudgmentBatch
  try {
    batch = await judgeBatch(evidenceById, FINDING_DIMENSION_QUESTIONS, EVALUATION_OPTIONS)
  } catch (error) {
    return Object.fromEntries(ids.map((id) => [id, degraded('batch-unavailable', null, errorText(error))]))
  }

  const result = Object.create(null) as Record<string, FindingEvaluation>
  let outcome: BatchEvaluationOutcome = { terminalFailure: null, drainShapeFailure: false }
  let cleanupError: string | null = null
  try {
    outcome = await drainBatch(batch, evidenceById, result)
  } finally {
    try {
      await batch.close()
    } catch (error) {
      cleanupError = errorText(error)
    }
  }

  if (outcome.terminalFailure !== null) {
    untouched(ids, result, outcome.terminalFailure.reason, outcome.terminalFailure.error)
  } else if (outcome.drainShapeFailure) {
    untouched(ids, result, 'invalid-drain-shape', null)
  } else {
    untouched(ids, result, 'missing-item', null)
  }
  if (cleanupError !== null) {
    for (const evaluation of Object.values(result)) {
      if (evaluation.error === null) evaluation.error = cleanupError
    }
  }
  return result
}
