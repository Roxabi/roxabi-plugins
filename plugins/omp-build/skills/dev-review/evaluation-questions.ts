import type { JudgeBatchOptions, JudgeQuestion } from './evaluation-contract'

export const FINDING_DIMENSION_QUESTIONS: Record<string, JudgeQuestion> = {
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

export const EVALUATION_OPTIONS: JudgeBatchOptions = {
  concurrency: 32,
  retries: 0,
  minOk: 1,
  intent: 'omp-build evidence qualification',
}
