import type {
  ConcreteConsequence,
  DegradedFindingEvaluation,
  EvaluationDegradation,
  EvidenceSupport,
  FindingDimensions,
  FindingEvaluation,
  SupportedApplicability,
  Uncertainty,
} from './evaluation-contract'

export function degraded(
  reason: EvaluationDegradation,
  backend: string | null = null,
  error: string | null = null,
): DegradedFindingEvaluation {
  return { status: 'degraded', reason, backend, error }
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return String(error)
}

function choice(answer: unknown, allowed: readonly string[]): string | null {
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) return null
  const candidate = answer as { type?: unknown; choice?: unknown }
  if (candidate.type !== 'choice' || typeof candidate.choice !== 'string') return null
  return allowed.includes(candidate.choice) ? candidate.choice : null
}

function dimensionsOf(answers: unknown): FindingDimensions | null {
  if (answers === null || typeof answers !== 'object' || Array.isArray(answers)) return null
  const response = answers as {
    evidenceSupport?: unknown
    supportedApplicability?: unknown
    concreteConsequence?: unknown
    uncertainty?: unknown
  }
  const evidenceSupport = choice(response.evidenceSupport, [
    'supported',
    'refuted',
    'unknown',
  ]) as EvidenceSupport | null
  const supportedApplicability = choice(response.supportedApplicability, [
    'applicable',
    'not-applicable',
    'unknown',
  ]) as SupportedApplicability | null
  const concreteConsequence = choice(response.concreteConsequence, [
    'concrete',
    'not-concrete',
    'unknown',
  ]) as ConcreteConsequence | null
  const uncertainty = choice(response.uncertainty, ['known', 'uncertain', 'unknown']) as Uncertainty | null
  if (!evidenceSupport || !supportedApplicability || !concreteConsequence || !uncertainty) return null
  return { evidenceSupport, supportedApplicability, concreteConsequence, uncertainty }
}

function normalizeItem(item: unknown): FindingEvaluation {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    return degraded('invalid-item', null, 'Judgment item is not an object')
  }
  const judgment = item as { model?: unknown; error?: unknown; answers?: unknown }
  const backend = typeof judgment.model === 'string' && judgment.model.length > 0 ? judgment.model : null
  if (judgment.error !== undefined) {
    if (typeof judgment.error !== 'string')
      return degraded('invalid-item', backend, 'Judgment item error is not a string')
    return degraded('judgment-error', backend, judgment.error)
  }
  if (backend === null) return degraded('missing-backend')
  if (!backend.startsWith('typesafe/') || backend.length === 'typesafe/'.length) {
    return degraded('non-typesafe-backend', backend)
  }
  const dimensions = dimensionsOf(judgment.answers)
  if (dimensions === null) return degraded('invalid-answers', backend)
  return { status: 'observed', backend, error: null, dimensions }
}

export function evaluateDrainedPair(pair: unknown): { id: string; evaluation: FindingEvaluation } | null {
  if (!Array.isArray(pair) || pair.length !== 2 || (typeof pair[0] !== 'string' && typeof pair[0] !== 'number'))
    return null
  return { id: String(pair[0]), evaluation: normalizeItem(pair[1]) }
}

export function untouched(
  ids: readonly string[],
  result: Record<string, FindingEvaluation>,
  reason: EvaluationDegradation,
  error: string | null,
): void {
  for (const id of ids) if (!Object.hasOwn(result, id)) result[id] = degraded(reason, null, error)
}
