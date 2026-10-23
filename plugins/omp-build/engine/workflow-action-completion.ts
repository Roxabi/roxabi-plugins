import type { DecodedHistory } from './history-schema.ts'
import { failedCheckEvidenceDigest, specDigest } from './record-digests.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { CanonicalRecord } from './record-schema.ts'
import { resolveAcceptedSpec } from './workflow-accepted-spec.ts'
import { type MandateRecord, mandateScope, type ReceiptRecord, recordsOf } from './workflow-control.ts'
import type { WorkflowGraphAction } from './workflow-graph.ts'
import { ciAttributionSchema, implementationOutputSchema } from './workflow-output-schema.ts'
import type { ActionCompletion, WorkflowEvidence } from './workflow-plan.ts'
import { planMacro } from './workflow-plan-macro.ts'
import type { SpecializedDecisions, WorkflowFacts } from './workflow-reconstruction-types.ts'
import { type AssessResultRecord, isAssessResult, sameAssessInputs } from './workflow-spec-authentication.ts'
import { authenticatedAssessResult } from './workflow-spec-authentication-chain.ts'
import { diagnostic, equalScope, sameRef } from './workflow-support.ts'

type ImplementationReceipt = ReceiptRecord & {
  payload: Extract<ReceiptRecord['payload'], { action: 'implement' }>
}

export function actionCompletion(
  action: WorkflowGraphAction,
  evidence: WorkflowEvidence,
  decisions: SpecializedDecisions,
  mandate: MandateRecord | null,
  facts: WorkflowFacts | null = null,
): ActionCompletion {
  switch (action) {
    case 'plan':
      return planCompletion(evidence, mandate)
    case 'implement':
      return implementationCompletion(evidence, mandate)
    case 'assess-spec':
      return assessSpecCompletion(evidence, facts, mandate)
    case 'attribute-ci':
      return ciAttributionCompletion(evidence, facts, mandate)
    case 'proof':
      return proofCompletion(decisions)
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

export function implementationCompletion(evidence: WorkflowEvidence, mandate: MandateRecord | null): ActionCompletion {
  const allReceipts = implementationReceipts(evidence.issue)
  const allStarts = allReceipts.filter((record) => record.payload.phase === 'start')
  const allResults = allReceipts.filter((record) => record.payload.phase === 'result')
  if (allStarts.some((start) => !allResults.some((result) => result.payload.actionId === start.payload.actionId))) {
    return { status: 'uncertain', evidence: [diagnostic('action-uncertain', 'implement start has no result')] }
  }
  if (allResults.some(isUnadmittedImplementation)) {
    return { status: 'blocked', evidence: [diagnostic('unconfirmed', 'implement result was not admitted')] }
  }
  const macro = planMacro(evidence, mandate)
  if (macro.phase === 'blocked') return { status: 'blocked', evidence: macro.evidence }
  if (macro.phase === 'uncertain') return { status: 'uncertain', evidence: macro.evidence }
  if (macro.phase !== 'eligible' || mandate === null) return { status: 'not-started', evidence: [] }
  const planActionId = macro.amendmentActionId ?? macro.draftActionId
  if (planActionId === null) return { status: 'not-started', evidence: [] }
  const receipts = implementationForPlan(allReceipts, mandate, planActionId)
  const starts = receipts.filter((record) => record.payload.phase === 'start')
  const results = receipts.filter((record) => record.payload.phase === 'result')
  if (starts.length === 0 && results.length === 0) return { status: 'not-started', evidence: [] }
  if (results.length > 0) return { status: 'confirmed', evidence: [] }
  return { status: 'blocked', evidence: [diagnostic('unconfirmed', 'implement result was not admitted')] }
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

function proofCompletion(decisions: SpecializedDecisions): ActionCompletion {
  if (decisions.proof.applicability === 'not-applicable' || decisions.proof.admission?.ok === true) {
    return { status: 'confirmed', evidence: decisions.proof.evidence }
  }
  return { status: 'not-started', evidence: decisions.proof.evidence }
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
  if (facts === null || mandate === null || facts.specBody === null || facts.specDigest === null) {
    return { status: 'not-started', evidence: [] }
  }
  if (specDigest(facts.specBody) !== facts.specDigest) {
    return { status: 'blocked', evidence: [diagnostic('material-spec', 'Live spec digest does not match its body')] }
  }
  const histories = [
    evidence.issue,
    ...(evidence.pullRequest === null ? [] : [evidence.pullRequest]),
    ...evidence.parents,
  ]
  const accepted = resolveAcceptedSpec(mandate, histories)
  if (!accepted.ok) return { status: 'uncertain', evidence: accepted.evidence }
  const mandateRef: ExternalRecordRef = { scope: mandateScope(mandate), recordId: mandate.recordId, kind: 'mandate' }
  const exactInputs = {
    acceptedBody: accepted.spec.body,
    acceptedDigest: accepted.spec.digest,
    currentBody: facts.specBody,
    currentDigest: facts.specDigest,
  }
  const receipts = recordsOf(evidence.issue).filter((record): record is ReceiptRecord =>
    isMatchingAssessment(record, mandateRef, exactInputs),
  )
  const starts = receipts.filter((record) => record.payload.phase === 'start')
  const results = receipts.filter((record): record is AssessResultRecord => isAssessResult(record))
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
  exactInputs: { acceptedBody: string; acceptedDigest: string; currentBody: string; currentDigest: string },
): boolean {
  return (
    record.kind === 'action-receipt' &&
    record.payload.action === 'assess-spec' &&
    sameRef(record.payload.mandate, mandateRef) &&
    sameAssessInputs(record.payload.exactInputs, exactInputs)
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

function implementationReceipts(history: WorkflowEvidence['issue']): ImplementationReceipt[] {
  return recordsOf(history).filter(
    (record): record is ImplementationReceipt =>
      record.kind === 'action-receipt' && record.payload.action === 'implement',
  )
}

function isUnadmittedImplementation(record: ImplementationReceipt): boolean {
  if (record.payload.phase !== 'result' || record.payload.admission?.admitted !== true) return true
  const parsed = implementationOutputSchema.safeParse(record.payload.structured)
  return !parsed.success || parsed.data.outcome !== 'implemented'
}

function implementationForPlan(
  receipts: readonly ImplementationReceipt[],
  mandate: MandateRecord,
  planActionId: string,
): ImplementationReceipt[] {
  const mandateRef: ExternalRecordRef = { scope: mandateScope(mandate), recordId: mandate.recordId, kind: 'mandate' }
  return receipts.filter(
    (record) =>
      sameRef(record.payload.mandate, mandateRef) &&
      record.payload.exactInputs.mandateId === mandate.recordId &&
      record.payload.exactInputs.planActionId === planActionId,
  )
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
