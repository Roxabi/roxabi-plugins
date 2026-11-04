import type { DecodedHistory } from './history-schema.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { OwnSpecRef } from './uw-spec-schema.ts'
import { resolveAcceptedSpecChain } from './workflow-accepted-spec-chain.ts'
import type { AcceptedOwnSpec, AcceptedSpecResult } from './workflow-accepted-spec-types.ts'
import { historyFor, type MandateRecord, mandateScope, workflowOperationProblem } from './workflow-control.ts'
import { confirmedAccountedMandate } from './workflow-pr-binding.ts'
import { specChainFailure } from './workflow-spec-assessment.ts'
import { type AssessmentReplayContext, confirmedAssessPairs } from './workflow-spec-authentication.ts'

function resolveSpec(
  mandate: MandateRecord,
  histories: readonly DecodedHistory[],
  replayContext?: AssessmentReplayContext,
  target?: OwnSpecRef,
  prefixes?: AcceptedOwnSpec[],
): AcceptedSpecResult {
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
  if (
    confirmed.payload.ownSpec.uw.repository !== scope.repository ||
    confirmed.payload.ownSpec.uw.target !== scope.target
  )
    return specChainFailure('material-spec', 'Mandate own Spec does not belong to its mandate scope')
  const pairs = confirmedAssessPairs(home, histories, mandateRef, replayContext)
  if (!pairs.ok) return pairs
  return resolveAcceptedSpecChain({ confirmed, home, histories, mandateRef, scope, target, prefixes })
}

export function resolveAcceptedSpec(
  mandate: MandateRecord,
  histories: readonly DecodedHistory[],
  replayContext?: AssessmentReplayContext,
): AcceptedSpecResult {
  return resolveSpec(mandate, histories, replayContext)
}

/** Authenticate a historical accepted prefix while still validating the entire current chain. */
export function resolveAcceptedSpecAt(
  mandate: MandateRecord,
  histories: readonly DecodedHistory[],
  target: OwnSpecRef,
): AcceptedSpecResult {
  return resolveSpec(mandate, histories, undefined, target)
}

/** Resolve the complete chain once; expose prefixes only after the full chain is authenticated. */
export function resolveAcceptedSpecPrefixes(
  mandate: MandateRecord,
  histories: readonly DecodedHistory[],
): { ok: true; prefixes: readonly AcceptedOwnSpec[] } | Extract<AcceptedSpecResult, { ok: false }> {
  const prefixes: AcceptedOwnSpec[] = []
  const result = resolveSpec(mandate, histories, undefined, undefined, prefixes)
  return result.ok ? { ok: true, prefixes } : result
}
