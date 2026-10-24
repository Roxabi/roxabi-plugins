import type { DecodedHistory } from './history-schema.ts'
import { specDigest } from './record-digests.ts'
import type { ExternalRecordRef } from './record-references.ts'
import { resolveAcceptedSpecChain } from './workflow-accepted-spec-chain.ts'
import type { AcceptedSpecResult } from './workflow-accepted-spec-types.ts'
import { historyFor, type MandateRecord, mandateScope, workflowOperationProblem } from './workflow-control.ts'
import { confirmedAccountedMandate } from './workflow-pr-binding.ts'
import { specChainFailure } from './workflow-spec-assessment.ts'
import { confirmedAssessPairs } from './workflow-spec-authentication.ts'

export function resolveAcceptedSpec(mandate: MandateRecord, histories: readonly DecodedHistory[]): AcceptedSpecResult {
  const scope = mandateScope(mandate)
  const home = historyFor(scope, histories)
  if (home === null || !home.source.complete) return specChainFailure('missing-history', 'Mandate history is missing')
  const problem = workflowOperationProblem(home)
  if (problem === 'ambiguous') return specChainFailure('ambiguous', 'Workflow history conflicts')
  if (problem === 'unconfirmed' || problem === 'incomplete')
    return specChainFailure('incomplete', 'Workflow history is not confirmed', problem)
  const mandateRef: ExternalRecordRef = { scope, recordId: mandate.recordId, kind: 'mandate' }
  const confirmed = confirmedAccountedMandate(home, mandateRef)
  if (confirmed === null)
    return specChainFailure('incomplete', 'Mandate is not a confirmed accounted record', 'unconfirmed')
  if (JSON.stringify(confirmed) !== JSON.stringify(mandate))
    return specChainFailure('ambiguous', 'Mandate does not match the authenticated history')
  if (specDigest(confirmed.payload.spec.body) !== confirmed.payload.spec.bodySha256)
    return specChainFailure('material-spec', 'Mandate spec digest does not match its body')
  const pairs = confirmedAssessPairs(home, histories, mandateRef)
  if (!pairs.ok) return pairs
  return resolveAcceptedSpecChain({ confirmed, home, histories, mandateRef, scope })
}
