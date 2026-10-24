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

export interface JudgeQuestion {
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
