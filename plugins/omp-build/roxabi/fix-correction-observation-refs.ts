import { isDeepStrictEqual } from 'node:util'
import { canonicalValueDigest, recordsOf } from '../dist/contracts.js'
import type { CorrectionEffectResult } from './correction-execution-contract.ts'
import type { FixRecord, PreparedFix } from './fix-contract.ts'
import { admitDecisionExecution, type DefaultFixWorkflow } from './fix-execution-policy.ts'
import type { RecordInputRef } from './uw-action-contract.ts'

export async function correctionObservationRefs(
  prepared: PreparedFix,
  decision: Extract<FixRecord, { kind: 'decision' }>,
  product: Pick<DefaultFixWorkflow, 'readHistory'>,
): Promise<CorrectionEffectResult<{ request: RecordInputRef; decision: RecordInputRef }>> {
  try {
    const history = await product.readHistory()
    if (!history.source.complete)
      return { ok: false, kind: 'terminal', diagnostics: ['correction-observation-history-incomplete'] }
    const admitted = admitDecisionExecution(decision, history)
    if (!admitted.ok) return { ok: false, kind: 'terminal', diagnostics: admitted.diagnostics }
    const records = recordsOf(history)
    const request = records.find((item) => item.kind === 'fix-request' && item.recordId === prepared.requestId)
    const storedDecision = records.find((item) => item.kind === 'decision' && item.recordId === decision.recordId)
    if (request === undefined || storedDecision === undefined || !isDeepStrictEqual(storedDecision, decision))
      return { ok: false, kind: 'terminal', diagnostics: ['correction-observation-record-unavailable'] }
    const ref = (item: typeof request | typeof storedDecision) => ({
      source: 'record' as const,
      record: {
        scope: { repository: item.repository, target: item.target },
        kind: item.kind,
        recordId: item.recordId,
      },
      selector: '/payload',
      digest: canonicalValueDigest(item.payload),
    })
    return { ok: true, value: { request: ref(request), decision: ref(storedDecision) } }
  } catch {
    return { ok: false, kind: 'terminal', diagnostics: ['correction-observation-history-unreadable'] }
  }
}
