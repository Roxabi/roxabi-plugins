import type { DecodedHistory } from './history-schema.ts'
import { specDigest } from './record-digests.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { Diagnostic, Scope } from './record-values.ts'
import { resolveAcceptedSpecChain } from './workflow-accepted-spec-chain.ts'
import { historyFor, type MandateRecord, mandateScope, workflowOperationProblem } from './workflow-control.ts'
import { confirmedAccountedMandate } from './workflow-pr-binding.ts'
import { confirmedAssessPairs, specChainFailure } from './workflow-spec-authentication.ts'

export type AcceptedSpecRef =
  | { kind: 'mandate'; recordId: string; scope: Scope; specDigest: string }
  | { kind: 'editorial'; recordId: string; scope: Scope; acceptedDigest: string; currentDigest: string }
  | { kind: 'accept-material'; recordId: string; scope: Scope; specDigest: string; assessment: ExternalRecordRef }

export type AcceptedSpec = {
  reference: string
  body: string
  digest: string
  lastEditedAt: string
  chain: readonly AcceptedSpecRef[]
  sourceRefs: readonly ExternalRecordRef[]
}

export type AcceptedSpecResult =
  | { ok: true; spec: AcceptedSpec }
  | { ok: false; reason: 'incomplete' | 'ambiguous' | 'material-spec' | 'missing-history'; evidence: Diagnostic[] }

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
