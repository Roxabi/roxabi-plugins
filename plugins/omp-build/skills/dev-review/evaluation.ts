export interface FindingEvidence {
  finding: string
  evidence: readonly string[]
  supportedScenario?: string
  contract?: string
  code?: string
  diff?: string
}

export type EvidenceSupport = 'supported' | 'refuted' | 'unknown'
export type SupportedApplicability = 'applicable' | 'not-applicable' | 'unknown'
export type ConcreteConsequence = 'concrete' | 'not-concrete' | 'unknown'
export type Uncertainty = 'known' | 'uncertain' | 'unknown'

export interface FindingDimensions {
  evidenceSupport: EvidenceSupport
  supportedApplicability: SupportedApplicability
  concreteConsequence: ConcreteConsequence
  uncertainty: Uncertainty
}

export interface ObservedFindingEvaluation {
  status: 'observed'
  backend: string
  error: string | null
  dimensions: FindingDimensions
}

export type EvaluationDegradation =
  | 'batch-unavailable'
  | 'drain-failed'
  | 'status-failed'
  | 'invalid-drain-shape'
  | 'invalid-item'
  | 'judgment-error'
  | 'missing-backend'
  | 'non-typesafe-backend'
  | 'invalid-answers'
  | 'missing-item'

export interface DegradedFindingEvaluation {
  status: 'degraded'
  reason: EvaluationDegradation
  backend: string | null
  error: string | null
}

export type FindingEvaluation = ObservedFindingEvaluation | DegradedFindingEvaluation

interface JudgeQuestion {
  type: 'choice'
  instructions: string
  criteria: Record<string, string>
}

export interface JudgeBatchOptions {
  concurrency: number
  retries: number
  minOk: number
  intent: string
}

export interface JudgmentBatch {
  drain(options: { timeout: number }): Promise<unknown>
  status(): Promise<unknown>
  close(): Promise<void>
}

export type JudgeBatch = (
  states: Record<string, FindingEvidence>,
  questions: Record<string, JudgeQuestion>,
  options: JudgeBatchOptions,
) => Promise<JudgmentBatch>

export interface EvaluationDependencies {
  judgeBatch: JudgeBatch
}

const FINDING_DIMENSION_QUESTIONS: Record<string, JudgeQuestion> = {
  evidenceSupport: {
    type: 'choice',
    instructions:
      'Assess whether the supplied evidence supports the finding. Do not infer missing callers, incidents, or code facts.',
    criteria: {
      supported: 'The supplied evidence directly supports the finding.',
      refuted: 'The supplied evidence directly contradicts the finding.',
      unknown: 'The supplied evidence is insufficient to support or refute the finding.',
    },
  },
  supportedApplicability: {
    type: 'choice',
    instructions:
      'Assess whether the finding applies to the supplied supported scenario and accepted contract. Do not treat imagined future configurations as supported use.',
    criteria: {
      applicable: 'The finding affects the supplied supported scenario or accepted contract.',
      'not-applicable':
        'The supplied evidence establishes that the finding does not affect the supplied supported scenario or accepted contract.',
      unknown: 'The supplied evidence is insufficient to establish applicability or non-applicability.',
    },
  },
  concreteConsequence: {
    type: 'choice',
    instructions:
      'Assess whether the supplied evidence establishes a concrete consequence. Absence of an incident is not evidence that there is no consequence.',
    criteria: {
      concrete: 'The supplied evidence establishes a concrete consequence for the supported scenario or contract.',
      'not-concrete':
        'The supplied evidence establishes that there is no concrete consequence for the supported scenario or contract.',
      unknown: 'The supplied evidence is insufficient to establish or rule out a concrete consequence.',
    },
  },
  uncertainty: {
    type: 'choice',
    instructions:
      'Assess the remaining uncertainty in the supplied evidence only. This is not incident frequency and not a confidence score.',
    criteria: {
      known: 'The supplied evidence resolves the material premises needed for this finding.',
      uncertain: 'Material premises remain unresolved in the supplied evidence.',
      unknown: 'The supplied evidence does not permit an uncertainty assessment.',
    },
  },
}

const EVALUATION_OPTIONS: JudgeBatchOptions = {
  concurrency: 32,
  retries: 0,
  minOk: 1,
  intent: 'omp-build evidence qualification',
}

function degraded(
  reason: EvaluationDegradation,
  backend: string | null = null,
  error: string | null = null,
): DegradedFindingEvaluation {
  return { status: 'degraded', reason, backend, error }
}

function errorText(error: unknown): string {
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

function evaluateDrainedPair(pair: unknown): { id: string; evaluation: FindingEvaluation } | null {
  if (!Array.isArray(pair) || pair.length !== 2 || (typeof pair[0] !== 'string' && typeof pair[0] !== 'number'))
    return null
  return { id: String(pair[0]), evaluation: normalizeItem(pair[1]) }
}

function untouched(
  ids: readonly string[],
  result: Record<string, FindingEvaluation>,
  reason: EvaluationDegradation,
  error: string | null,
): void {
  for (const id of ids) if (!Object.hasOwn(result, id)) result[id] = degraded(reason, null, error)
}

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
  let terminalFailure: { reason: 'drain-failed' | 'status-failed'; error: string } | null = null
  let drainShapeFailure = false
  let cleanupError: string | null = null
  let drained = 0

  try {
    while (true) {
      let rawPairs: unknown
      try {
        rawPairs = await batch.drain({ timeout: 30 })
      } catch (error) {
        terminalFailure = { reason: 'drain-failed', error: errorText(error) }
        break
      }
      if (!Array.isArray(rawPairs)) {
        drainShapeFailure = true
        break
      }

      drained += rawPairs.length
      for (const pair of rawPairs) {
        const normalized = evaluateDrainedPair(pair)
        if (normalized === null) {
          drainShapeFailure = true
          continue
        }
        if (Object.hasOwn(evidenceById, normalized.id)) result[normalized.id] = normalized.evaluation
      }

      let rawStatus: unknown
      try {
        rawStatus = await batch.status()
      } catch (error) {
        terminalFailure = { reason: 'status-failed', error: errorText(error) }
        break
      }
      if (rawStatus === null || typeof rawStatus !== 'object' || Array.isArray(rawStatus)) {
        terminalFailure = { reason: 'status-failed', error: 'Judgment batch status is not an object' }
        break
      }
      const status = rawStatus as { done?: unknown; running?: unknown }
      if (
        typeof status.running !== 'boolean' ||
        typeof status.done !== 'number' ||
        !Number.isInteger(status.done) ||
        status.done < 0
      ) {
        terminalFailure = { reason: 'status-failed', error: 'Judgment batch status has invalid completion fields' }
        break
      }
      if (status.running) continue
      if (drained < status.done && rawPairs.length > 0) continue
      if (drained < status.done) drainShapeFailure = true
      break
    }
  } finally {
    try {
      await batch.close()
    } catch (error) {
      cleanupError = errorText(error)
    }
  }

  if (terminalFailure !== null) untouched(ids, result, terminalFailure.reason, terminalFailure.error)
  else if (drainShapeFailure) untouched(ids, result, 'invalid-drain-shape', null)
  else untouched(ids, result, 'missing-item', null)
  if (cleanupError !== null) {
    for (const evaluation of Object.values(result)) {
      if (evaluation.error === null) evaluation.error = cleanupError
    }
  }
  return result
}
