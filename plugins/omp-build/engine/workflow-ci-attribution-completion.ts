import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope } from './record-diagnostics.ts'
import { failedCheckEvidenceDigest } from './record-digests.ts'
import type { CanonicalRecord } from './record-schema.ts'
import { classifyAttempts, interruptionGate } from './workflow-action-interruption.ts'
import { excludedReceipt, type MandateRecord, mandateScope, type ReceiptRecord, recordsOf } from './workflow-control.ts'
import { ciAttributionSchema } from './workflow-output-schema.ts'
import type { ActionCompletion, WorkflowEvidence } from './workflow-plan.ts'
import type { ActionReceiptPayload } from './workflow-receipt-schema.ts'
import type { WorkflowFacts } from './workflow-reconstruction-types.ts'

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
  )
    return { change: false, refused: false }
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

export function ciAttributionCompletion(
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
  if (starts.some((start) => !results.some((result) => result.payload.actionId === start.payload.actionId)))
    return { status: 'uncertain', evidence: [diagnostic('action-uncertain', 'CI attribution start has no result')] }
  if (
    facts === null ||
    mandate === null ||
    facts.pullRequest === null ||
    facts.candidateGitSHA === null ||
    facts.evidenceDigest == null
  )
    return { status: 'not-started', evidence: [] }
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

export function ciInputsMatch(
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
