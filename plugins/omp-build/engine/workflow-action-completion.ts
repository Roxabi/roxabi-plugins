import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope, sameRef } from './record-diagnostics.ts'
import { failedCheckEvidenceDigest } from './record-digests.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { CanonicalRecord } from './record-schema.ts'
import { resolveAcceptedSpec } from './workflow-accepted-spec.ts'
import { workflowContextNegative, workflowContextTerminal } from './workflow-context-terminal.ts'
import { type MandateRecord, mandateScope, type ReceiptRecord, recordsOf } from './workflow-control.ts'
import type { WorkflowGraphAction } from './workflow-graph.ts'
import { implementationCompletion } from './workflow-implementation-completion.ts'
import { ciAttributionSchema } from './workflow-output-schema.ts'
import type { ActionCompletion, WorkflowEvidence } from './workflow-plan.ts'
import { planMacro } from './workflow-plan-macro.ts'

import type { AssessSpecExact } from './workflow-receipt-schema.ts'
import type { SpecializedDecisions, WorkflowFacts } from './workflow-reconstruction-types.ts'
import {
  type AssessResultRecord,
  isAssessResult,
  mechanicalSpecDelta,
  sameAssessedState,
  sameCurrentAssessedState,
} from './workflow-spec-assessment.ts'
import { authenticatedAssessResult } from './workflow-spec-authentication-chain.ts'

export function actionCompletion(
  action: WorkflowGraphAction,
  evidence: WorkflowEvidence,
  decisions: SpecializedDecisions,
  mandate: MandateRecord | null,
  facts: WorkflowFacts | null = null,
): ActionCompletion {
  const context = contextCompletion(action, evidence)
  if (context !== null) return context
  switch (action) {
    case 'plan':
      return planCompletion(evidence, mandate)
    case 'implement':
      return implementationCompletion(evidence, mandate)
    case 'assess-spec':
      return assessSpecCompletion(evidence, facts, mandate)
    case 'attribute-ci':
      return ciAttributionCompletion(evidence, facts, mandate)
    case 'publish':
      return selectedCompletion(decisions.publish)
    case 'land':
      return selectedCompletion(decisions.landing)
    case 'watch':
      return selectedCompletion(decisions.watch)
    default:
      return receiptCompletion(evidence.issue, action)
  }
}

function contextCompletion(action: WorkflowGraphAction, evidence: WorkflowEvidence): ActionCompletion | null {
  if (action !== 'frame' && action !== 'assess-spec' && action !== 'attribute-ci') return null
  const histories = [evidence.issue, ...(evidence.pullRequest === null ? [] : [evidence.pullRequest])]
  for (const history of histories) {
    const terminal = workflowContextTerminal(history, action)
    if (terminal === 'missing')
      return {
        status: 'blocked',
        evidence: [diagnostic('action-context-missing', `${action} requires expanded context`)],
      }
    if (terminal === 'uncertain')
      return {
        status: 'uncertain',
        evidence: [diagnostic('action-uncertain', `${action} context result is not authenticated`)],
      }
    if (terminal === 'ambiguous')
      return {
        status: 'blocked',
        evidence: [diagnostic('ambiguous', `${action} context result has competing successors`)],
      }
  }
  return null
}

export function boundCiAttribution(
  histories: readonly DecodedHistory[],
  facts: WorkflowFacts,
  mandate: MandateRecord | null,
): { change: boolean; refused: boolean } {
  const digest = facts.evidenceDigest
  if (
    mandate === null ||
    facts.pullRequest === null ||
    facts.candidateGitSHA === null ||
    digest == null ||
    !/^[0-9a-f]{64}$/.test(digest)
  ) {
    return { change: false, refused: false }
  }
  let change = false
  let refused = false
  for (const history of histories) {
    for (const record of recordsOf(history)) {
      const attribution = ciAttribution(record, facts, mandate, digest)
      if (attribution === 'change') change = true
      if (attribution === 'refused') refused = true
    }
  }
  return { change, refused }
}

function planCompletion(evidence: WorkflowEvidence, mandate: MandateRecord | null): ActionCompletion {
  const macro = planMacro(evidence, mandate)
  if (macro.phase === 'eligible') return { status: 'confirmed', evidence: macro.evidence }
  if (macro.phase === 'blocked') return { status: 'blocked', evidence: macro.evidence }
  if (macro.phase === 'uncertain') return { status: 'uncertain', evidence: macro.evidence }
  return { status: 'not-started', evidence: macro.evidence }
}

function selectedCompletion(
  selector: SpecializedDecisions['publish'] | SpecializedDecisions['landing'] | SpecializedDecisions['watch'],
): ActionCompletion {
  if (selector.status === 'published' || selector.status === 'not-applicable') {
    return { status: 'confirmed', evidence: selector.evidence }
  }
  if (selector.status === 'uncertain') return { status: 'uncertain', evidence: selector.evidence }
  if (selector.status === 'failed') return { status: 'blocked', evidence: selector.evidence }
  return { status: 'not-started', evidence: selector.evidence }
}

function receiptCompletion(history: WorkflowEvidence['issue'], action: string): ActionCompletion {
  const progress = receiptProgress(history, action)
  if (progress === 'uncertain') {
    return { status: 'uncertain', evidence: [diagnostic('action-uncertain', `${action} started without a result`)] }
  }
  return { status: progress === 'confirmed' ? 'confirmed' : 'not-started', evidence: [] }
}

function receiptProgress(
  history: WorkflowEvidence['issue'],
  action: string,
): 'not-started' | 'confirmed' | 'uncertain' {
  const receipts = recordsOf(history).filter(
    (record): record is ReceiptRecord => record.kind === 'action-receipt' && record.payload.action === action,
  )
  const starts = receipts.filter((record) => record.payload.phase === 'start')
  const results = receipts.filter((record) => record.payload.phase === 'result')
  if (starts.length === 0 && results.length === 0) return 'not-started'
  if (starts.some((start) => !results.some((result) => result.payload.actionId === start.payload.actionId)))
    return 'uncertain'
  return results.length > 0 ? 'confirmed' : 'uncertain'
}

function assessSpecCompletion(
  evidence: WorkflowEvidence,
  facts: WorkflowFacts | null,
  mandate: MandateRecord | null,
): ActionCompletion {
  if (facts === null || mandate === null || facts.currentSpec === null || facts.identityAllocations === null) {
    return { status: 'not-started', evidence: [] }
  }
  const histories = [
    evidence.issue,
    ...(evidence.pullRequest === null ? [] : [evidence.pullRequest]),
    ...evidence.parents,
  ]
  const accepted = resolveAcceptedSpec(mandate, histories)
  if (!accepted.ok) return { status: 'uncertain', evidence: accepted.evidence }
  const mandateRef: ExternalRecordRef = { scope: mandateScope(mandate), recordId: mandate.recordId, kind: 'mandate' }
  const exactInputs: AssessSpecExact = {
    format: 'omp-build-spec-assessment/2',
    accepted: {
      ref: accepted.spec.ref,
      snapshot: accepted.spec.snapshot,
      tier: accepted.spec.tier,
      children: accepted.spec.children,
    },
    proposed: facts.currentSpec,
    identityAllocations: facts.identityAllocations,
    mechanical: mechanicalSpecDelta(
      {
        snapshot: accepted.spec.snapshot,
        tier: accepted.spec.tier,
        children: accepted.spec.children,
      },
      facts.currentSpec,
    ),
  }
  const receipts = recordsOf(evidence.issue).filter((record): record is ReceiptRecord =>
    isMatchingAssessment(record, mandateRef, exactInputs),
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
  const authenticated = authenticatedAssessResult(result, histories, mandateRef)
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
    JSON.stringify(inputs.identityAllocations) === JSON.stringify(exactInputs.identityAllocations) &&
    JSON.stringify(inputs.mechanical) === JSON.stringify(exactInputs.mechanical)
  )
}

function ciAttributionCompletion(
  evidence: WorkflowEvidence,
  facts: WorkflowFacts | null,
  mandate: MandateRecord | null,
): ActionCompletion {
  const histories = [evidence.issue, ...(evidence.pullRequest === null ? [] : [evidence.pullRequest])]
  const receipts = histories.flatMap((history) =>
    recordsOf(history).filter(
      (record): record is ReceiptRecord => record.kind === 'action-receipt' && record.payload.action === 'attribute-ci',
    ),
  )
  const starts = receipts.filter((record) => record.payload.phase === 'start')
  const results = receipts.filter((record) => record.payload.phase === 'result')
  if (starts.some((start) => !results.some((result) => result.payload.actionId === start.payload.actionId))) {
    return { status: 'uncertain', evidence: [diagnostic('action-uncertain', 'CI attribution start has no result')] }
  }
  if (
    facts === null ||
    mandate === null ||
    facts.pullRequest === null ||
    facts.candidateGitSHA === null ||
    facts.evidenceDigest === null
  ) {
    return { status: 'not-started', evidence: [] }
  }
  const bound = boundCiAttribution(histories, facts, mandate)
  return bound.change || bound.refused ? { status: 'confirmed', evidence: [] } : { status: 'not-started', evidence: [] }
}

function ciAttribution(
  record: CanonicalRecord,
  facts: WorkflowFacts,
  mandate: MandateRecord,
  digest: string,
): 'change' | 'refused' | null {
  if (record.kind !== 'action-receipt' || record.payload.action !== 'attribute-ci' || record.payload.phase !== 'result')
    return null
  if (record.payload.mandate.recordId !== mandate.recordId || record.payload.mandate.kind !== 'mandate') return null
  if (!equalScope(record.payload.mandate.scope, mandateScope(mandate))) return null
  const inputs = record.payload.exactInputs
  if (inputs.candidateGitSHA !== facts.candidateGitSHA) return null
  if (facts.pullRequest === null || !equalScope(inputs.scope, facts.pullRequest.scope)) return null
  if (inputs.evidenceDigest !== digest || failedCheckEvidenceDigest(inputs) !== digest) return null
  const parsed = ciAttributionSchema.safeParse(record.payload.structured)
  if (!parsed.success) return null
  return parsed.data.attribution === 'change' ? 'change' : 'refused'
}
