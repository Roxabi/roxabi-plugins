import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope } from './record-diagnostics.ts'
import { failedCheckEvidenceDigest } from './record-digests.ts'
import type { CanonicalRecord } from './record-schema.ts'
import { classifyAttempts, interruptionGate } from './workflow-action-interruption.ts'
import { assessSpecCompletion } from './workflow-assessment-completion.ts'
import { workflowContextTerminal } from './workflow-context-terminal.ts'
import { excludedReceipt, type MandateRecord, mandateScope, type ReceiptRecord, recordsOf } from './workflow-control.ts'
import type { WorkflowGraphAction } from './workflow-graph.ts'
import { implementationCompletion } from './workflow-implementation-completion.ts'
import { ciAttributionSchema } from './workflow-output-schema.ts'
import type { ActionCompletion, WorkflowEvidence } from './workflow-plan.ts'
import { planMacro } from './workflow-plan-macro.ts'
import type { ActionReceiptPayload } from './workflow-receipt-schema.ts'

import type { SpecializedDecisions, WorkflowFacts } from './workflow-reconstruction-types.ts'

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
  const classified =
    action === 'frame'
      ? null
      : classifyAttempts({
          histories: [...histories, ...evidence.causal.histories],
          scan: histories,
          actions: [action],
        })
  if (classified !== null && !classified.ok) return { status: 'blocked', evidence: classified.diagnostics }
  for (const history of histories) {
    const terminal = workflowContextTerminal(history, action, undefined, classified?.value.excluded)
    if (terminal !== 'clear' && classified !== null) {
      const gate = interruptionGate(classified)
      if (gate.kind === 'stop') return gate.completion
    }
    const decision = contextTerminalDecision(action, terminal)
    if (decision !== null) return decision
  }
  return null
}

function contextTerminalDecision(
  action: WorkflowGraphAction,
  terminal: 'clear' | 'missing' | 'uncertain' | 'ambiguous',
): ActionCompletion | null {
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
  // An invalid resolution index yields no attribution, so the walk reaches the attribution gate and blocks there.
  const classified = classifyAttempts({ histories, scan: histories, actions: ['attribute-ci'] })
  if (!classified.ok) return { change: false, refused: false }
  let change = false
  let refused = false
  for (const record of histories.flatMap(recordsOf)) {
    if (record.kind === 'action-receipt' && excludedReceipt(record, classified.value.excluded)) continue
    const attribution = ciAttribution(record, facts, mandate, digest)
    if (attribution === 'change') change = true
    if (attribution === 'refused') refused = true
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

function ciAttributionCompletion(
  evidence: WorkflowEvidence,
  facts: WorkflowFacts | null,
  mandate: MandateRecord | null,
): ActionCompletion {
  const histories = [evidence.issue, ...(evidence.pullRequest === null ? [] : [evidence.pullRequest])]
  const gate = interruptionGate(
    classifyAttempts({
      histories: [...histories, ...evidence.causal.histories],
      scan: histories,
      actions: ['attribute-ci'],
    }),
  )
  if (gate.kind === 'stop') return gate.completion
  const receipts = histories.flatMap((history) =>
    recordsOf(history).filter(
      (record): record is ReceiptRecord =>
        record.kind === 'action-receipt' &&
        record.payload.action === 'attribute-ci' &&
        !excludedReceipt(record, gate.excluded),
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
    facts.evidenceDigest == null
  ) {
    return { status: 'not-started', evidence: [] }
  }
  for (const record of results) {
    const payload = record.payload
    if (
      payload.phase === 'result' &&
      payload.action === 'attribute-ci' &&
      payload.structured === null &&
      payload.diagnostics.some(({ code }) => code === 'attribute-ci-output-invalid' || code === 'action-uncertain') &&
      ciInputsMatch(payload, facts, mandate, facts.evidenceDigest)
    )
      return { status: 'blocked', evidence: payload.diagnostics }
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
  if (!ciInputsMatch(record.payload, facts, mandate, digest)) return null
  const parsed = ciAttributionSchema.safeParse(record.payload.structured)
  if (!parsed.success) return null
  return parsed.data.attribution === 'change' ? 'change' : 'refused'
}

function ciInputsMatch(
  payload: Extract<ActionReceiptPayload, { action: 'attribute-ci'; phase: 'result' }>,
  facts: WorkflowFacts,
  mandate: MandateRecord,
  digest: string,
): boolean {
  if (payload.mandate.recordId !== mandate.recordId || payload.mandate.kind !== 'mandate') return false
  if (!equalScope(payload.mandate.scope, mandateScope(mandate))) return false
  const inputs = payload.exactInputs
  return (
    inputs.candidateGitSHA === facts.candidateGitSHA &&
    facts.pullRequest !== null &&
    equalScope(inputs.scope, facts.pullRequest.scope) &&
    inputs.evidenceDigest === digest &&
    failedCheckEvidenceDigest(inputs) === digest
  )
}
