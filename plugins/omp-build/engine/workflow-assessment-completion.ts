import { diagnostic, sameRef } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { CanonicalRecord } from './record-schema.ts'
import { resolveAcceptedSpec } from './workflow-accepted-spec.ts'
import { classifyAttempts, interruptionGate } from './workflow-action-interruption.ts'
import { capturedChildOwnSources } from './workflow-assessment-child-sources.ts'
import { workflowContextNegative } from './workflow-context-output.ts'
import {
  createHistoricalAcceptedSpecContext,
  historicalAcceptedSpecFrame,
} from './workflow-context-succession-inspection.ts'
import { excludedReceipt, type MandateRecord, mandateScope, type ReceiptRecord, recordsOf } from './workflow-control.ts'
import type { ActionCompletion, WorkflowEvidence } from './workflow-plan.ts'
import type { AssessSpecExact } from './workflow-receipt-schema.ts'
import type { WorkflowFacts } from './workflow-reconstruction-types.ts'
import {
  type AssessResultRecord,
  isAssessResult,
  mechanicalSpecDelta,
  sameAssessedState,
  sameCurrentAssessedState,
} from './workflow-spec-assessment.ts'
import { assessmentPrestartContext } from './workflow-spec-authentication.ts'
import { authenticatedAssessResult } from './workflow-spec-authentication-chain.ts'

export function assessSpecCompletion(
  evidence: WorkflowEvidence,
  facts: WorkflowFacts | null,
  mandate: MandateRecord | null,
  selectedNegative?: ReceiptRecord,
): ActionCompletion {
  if (facts === null || mandate === null || facts.currentSpec === null || facts.identityAllocations === null) {
    return { status: 'not-started', evidence: [] }
  }
  const historical = createHistoricalAcceptedSpecContext(evidence.causal.histories)
  if (!historical.ok) return { status: 'blocked', evidence: historical.diagnostics }
  const frame = historicalAcceptedSpecFrame(historical.value, evidence.causal.histories, mandate)
  if (!frame.ok) return { status: 'blocked', evidence: frame.diagnostics }
  const inspection = frame.value.inspection
  const accepted = resolveAcceptedSpec(
    mandate,
    evidence.causal.histories,
    assessmentPrestartContext(facts),
    inspection,
    historical.value,
  )
  if (!accepted.ok) return { status: 'uncertain', evidence: accepted.evidence }
  const mandateRef: ExternalRecordRef = { scope: mandateScope(mandate), recordId: mandate.recordId, kind: 'mandate' }
  const childOwnSources = capturedChildOwnSources(
    {
      ref: accepted.spec.ref,
      snapshot: accepted.spec.snapshot,
      tier: accepted.spec.tier,
      children: accepted.spec.children,
      inheritedOwnSpecRefs: accepted.spec.inheritedOwnSpecRefs,
      coverage: accepted.spec.coverage,
    },
    facts.currentSpec,
    evidence.causal.histories,
    [],
    assessmentPrestartContext(facts),
    historical.value,
  )
  if (childOwnSources === null)
    return {
      status: 'uncertain',
      evidence: [diagnostic('incomplete', 'Current child own authorities cannot be captured')],
    }
  const exactInputs: AssessSpecExact = {
    format: 'omp-build-spec-assessment/3',
    accepted: {
      ref: accepted.spec.ref,
      snapshot: accepted.spec.snapshot,
      tier: accepted.spec.tier,
      children: accepted.spec.children,
      inheritedOwnSpecRefs: accepted.spec.inheritedOwnSpecRefs,
      coverage: accepted.spec.coverage,
    },
    proposed: facts.currentSpec,
    childOwnSources: childOwnSources.childOwnSources,
    attachedChildren: [],
    attachedWayfinders: [],
    identityAllocations: facts.identityAllocations,
    mechanical: mechanicalSpecDelta(
      {
        snapshot: accepted.spec.snapshot,
        tier: accepted.spec.tier,
        children: accepted.spec.children,
        inheritedOwnSpecRefs: accepted.spec.inheritedOwnSpecRefs,
        coverage: accepted.spec.coverage,
      },
      facts.currentSpec,
    ),
  }
  if (selectedNegative !== undefined && !isMatchingAssessment(selectedNegative, mandateRef, exactInputs))
    return {
      status: 'blocked',
      evidence: [diagnostic('action-context-missing', 'Assessment context no longer matches current Spec')],
    }
  const gate = interruptionGate(
    classifyAttempts({
      histories: [evidence.issue, ...evidence.causal.histories],
      scan: [evidence.issue],
      actions: ['assess-spec'],
      select: (record) => isMatchingAssessment(record, mandateRef, exactInputs),
    }),
  )
  if (gate.kind === 'stop') return gate.completion
  const receipts = recordsOf(evidence.issue).filter(
    (record): record is ReceiptRecord =>
      isMatchingAssessment(record, mandateRef, exactInputs) &&
      record.kind === 'action-receipt' &&
      !excludedReceipt(record, gate.excluded),
  )
  const negativeIds = new Set(receipts.filter(workflowContextNegative).map((record) => record.payload.actionId))
  const starts = receipts.filter(
    (record) => record.payload.phase === 'start' && !negativeIds.has(record.payload.actionId),
  )
  const results = receipts.filter(
    (record): record is AssessResultRecord => isAssessResult(record) && !negativeIds.has(record.payload.actionId),
  )
  if (starts.length === 0 && results.length === 0) return { status: 'not-started', evidence: [] }
  if (starts.length !== 1 || results.length !== 1) {
    return {
      status: 'uncertain',
      evidence: [diagnostic('unconfirmed', 'Current spec assessment is not uniquely paired')],
    }
  }
  const result = results[0]
  if (result === undefined) {
    return { status: 'uncertain', evidence: [diagnostic('unconfirmed', 'Current spec assessment is missing')] }
  }
  const authenticated = authenticatedAssessResult(result, evidence.causal.histories, mandateRef)
  return authenticated.ok
    ? { status: 'confirmed', evidence: [] }
    : { status: 'uncertain', evidence: authenticated.evidence }
}

function isMatchingAssessment(
  record: CanonicalRecord,
  mandateRef: ExternalRecordRef,
  exactInputs: AssessSpecExact,
): boolean {
  if (
    record.kind !== 'action-receipt' ||
    record.payload.action !== 'assess-spec' ||
    !sameRef(record.payload.mandate, mandateRef)
  )
    return false
  const inputs = record.payload.exactInputs
  return (
    inputs.format === exactInputs.format &&
    sameAssessedState(inputs.accepted, exactInputs.accepted) &&
    sameCurrentAssessedState(inputs.proposed, exactInputs.proposed) &&
    JSON.stringify(inputs.attachedChildren) === JSON.stringify(exactInputs.attachedChildren) &&
    JSON.stringify(inputs.attachedWayfinders) === JSON.stringify(exactInputs.attachedWayfinders) &&
    JSON.stringify(inputs.childOwnSources) === JSON.stringify(exactInputs.childOwnSources) &&
    JSON.stringify(inputs.identityAllocations) === JSON.stringify(exactInputs.identityAllocations) &&
    JSON.stringify(inputs.mechanical) === JSON.stringify(exactInputs.mechanical)
  )
}
