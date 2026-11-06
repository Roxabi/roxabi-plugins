import { canonicalValueDigest } from './canonical-value.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, sameRef } from './record-diagnostics.ts'
import { checkAuthenticatedSpecCompatibility, resolveAcceptedSpec } from './workflow-accepted-spec.ts'
import { capturedAssessmentSourcesMatch, capturedChildOwnSources } from './workflow-assessment-child-sources.ts'
import { workflowContextNegative, workflowContextTerminal } from './workflow-context-terminal.ts'
import { type MandateRecord, mandateScope, recordsOf } from './workflow-control.ts'
import { specAssessmentSchema } from './workflow-output-schema.ts'
import type { WorkflowDecision, WorkflowFacts } from './workflow-reconstruction-types.ts'
import {
  type AssessResultRecord,
  isAssessResult,
  isMechanical,
  mechanicalSpecDelta,
  sameAssessedState,
  sameCurrentAssessedState,
} from './workflow-spec-assessment.ts'
import { authenticatedAssessResult } from './workflow-spec-authentication-chain.ts'

function specDecisionRequired(code: string, message: string): WorkflowDecision {
  return { status: 'blocked', reason: 'spec-decision-required', evidence: [diagnostic(code, message)] }
}

function matchingAssessments(
  history: DecodedHistory,
  mandate: MandateRecord,
  facts: WorkflowFacts,
): AssessResultRecord[] {
  const currentSpec = facts.currentSpec
  if (currentSpec === null) return []
  return recordsOf(history).filter(
    (record): record is AssessResultRecord =>
      isAssessResult(record) &&
      !(workflowContextNegative(record) && workflowContextTerminal(history, 'assess-spec') === 'clear') &&
      sameRef(record.payload.mandate, { scope: mandateScope(mandate), recordId: mandate.recordId, kind: 'mandate' }) &&
      sameCurrentAssessedState(record.payload.exactInputs.proposed, currentSpec),
  )
}

export function assessmentDecision(
  history: DecodedHistory,
  mandate: MandateRecord,
  facts: WorkflowFacts,
  histories: readonly DecodedHistory[],
): WorkflowDecision | null {
  const assessments = matchingAssessments(history, mandate, facts)
  if (assessments.length === 0) return null
  const accepted = resolveAcceptedSpec(mandate, histories)
  if (!accepted.ok) return { status: 'terminal', reason: 'spec-ambiguous', evidence: accepted.evidence }
  const qualified = assessments.filter((assessment) =>
    sameAssessedState(assessment.payload.exactInputs.accepted, {
      ref: accepted.spec.ref,
      snapshot: accepted.spec.snapshot,
      tier: accepted.spec.tier,
      children: accepted.spec.children,
      inheritedOwnSpecRefs: accepted.spec.inheritedOwnSpecRefs,
      coverage: accepted.spec.coverage,
    }),
  )
  if (qualified.length > 1) {
    return {
      status: 'terminal',
      reason: 'spec-ambiguous',
      evidence: [diagnostic('spec-ambiguous', 'Competing assessments match the active Spec pair')],
    }
  }
  const assessment = qualified[0]
  return assessment === undefined ? null : authenticatedAssessmentDecision(assessment, mandate, histories)
}

function authenticatedAssessmentDecision(
  assessment: AssessResultRecord,
  mandate: MandateRecord,
  histories: readonly DecodedHistory[],
): WorkflowDecision | null {
  const authenticated = authenticatedAssessResult(assessment, histories, {
    scope: mandateScope(mandate),
    recordId: mandate.recordId,
    kind: 'mandate',
  })
  if (!authenticated.ok) return { status: 'terminal', reason: 'spec-ambiguous', evidence: authenticated.evidence }
  const parsed = specAssessmentSchema.safeParse(authenticated.record.payload.structured)
  if (!parsed.success) {
    return {
      status: 'terminal',
      reason: 'spec-ambiguous',
      evidence: [diagnostic('spec-ambiguous', 'Spec assessment result is malformed')],
    }
  }
  if (parsed.data.compatibility.state !== 'consistent')
    return specDecisionRequired(
      'constraint-compatibility-unresolved',
      `Constraint compatibility is ${parsed.data.compatibility.state}`,
    )
  const compatibilityProblem = checkAuthenticatedSpecCompatibility(
    authenticated.record,
    parsed.data,
    histories,
    mandate,
  )
  if (compatibilityProblem !== null)
    return specDecisionRequired('constraint-compatibility-unresolved', compatibilityProblem)
  const exact = authenticated.record.payload.exactInputs
  const currentChildren = capturedChildOwnSources(exact.accepted, exact.proposed, histories, exact.attachedChildren)
  if (
    currentChildren === null ||
    canonicalValueDigest(currentChildren.childOwnSources) !== canonicalValueDigest(exact.childOwnSources) ||
    !capturedAssessmentSourcesMatch(
      currentChildren,
      authenticated.record.payload.inputs.manifest.acceptedSources,
      histories,
    )
  )
    return specDecisionRequired(
      'assessment-child-sources-stale',
      'Current child own authorities differ from the captured assessment',
    )
  const mechanical = mechanicalSpecDelta(exact.accepted, exact.proposed)
  if (
    isMechanical(mechanical) ||
    parsed.data.classification === 'unknown' ||
    parsed.data.classification === 'material'
  ) {
    return specDecisionRequired(
      'spec-decision-required',
      parsed.data.classification === 'unknown'
        ? 'Authenticated Spec assessment requires an operator decision'
        : 'Material spec change has no operator decision',
    )
  }
  return null
}
