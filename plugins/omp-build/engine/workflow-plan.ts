import type { DecodedHistory } from './history-schema.ts'
import type { Diagnostic } from './record-values.ts'
import type { ReviewClassCatalogues } from './review-class-catalogue.ts'
import type { UwCompletionObservation } from './uw-completion-types.ts'
import type { PlanBlockerRef } from './workflow-output-schema.ts'

export type WorkflowCausalContext = Readonly<{
  histories: readonly DecodedHistory[]
  catalogues: ReviewClassCatalogues
  observation: Extract<UwCompletionObservation, { status: 'complete' }>
}>

export type WorkflowEvidence = {
  issue: DecodedHistory
  pullRequest: DecodedHistory | null
  parents: readonly DecodedHistory[]
  causal: WorkflowCausalContext
}
export type ActionCompletion = { status: 'not-started' | 'confirmed' | 'uncertain' | 'blocked'; evidence: Diagnostic[] }
export type PlanMacroPhase = 'needs-draft' | 'needs-review' | 'needs-amendment' | 'eligible' | 'blocked' | 'uncertain'
export type PlanMacro = {
  phase: PlanMacroPhase
  mandateId: string | null
  specDigest: string | null
  draftActionId: string | null
  reviewActionId: string | null
  amendmentActionId: string | null
  blockers: PlanBlockerRef[]
  evidence: Diagnostic[]
}
