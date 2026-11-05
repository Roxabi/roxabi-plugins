import type { DecodedHistory } from '../engine/history-schema.ts'
import type { Result } from '../engine/result.ts'
import type { ReviewClassCatalogues } from '../engine/review-class-catalogue.ts'
import type { RecordInputRef, UwActionRequest } from './uw-action-contract.ts'
import { actionFailure } from './uw-action-result.ts'
import { priorCorrectionContribution } from './uw-correction-stage-contribution.ts'
import { priorCorrectionDecision } from './uw-correction-stage-decision.ts'

function priorCorrectionStage(
  ref: RecordInputRef,
  request: UwActionRequest,
  histories: readonly DecodedHistory[],
  catalogues: ReviewClassCatalogues,
): Result<boolean> {
  const decision = priorCorrectionDecision(ref, request, histories, catalogues)
  if (!decision.ok || decision.value) return decision
  return priorCorrectionContribution(ref, request, histories, catalogues)
}

export function refuseOutsideStage(
  request: UwActionRequest,
  outputs: ReadonlySet<string>,
  histories: readonly DecodedHistory[],
  catalogues: ReviewClassCatalogues,
): Result<true> {
  for (const ref of request.stageSources) {
    const { scope, kind, recordId } = ref.record
    const owned = outputs.has([scope.repository, scope.target, kind, recordId].join('\0'))
    if (request.purpose !== 'correction') {
      if (!owned) return actionFailure('self-output', 'Stage annex cites a record outside the current root')
      continue
    }
    if (owned) return actionFailure('self-output', 'Correction stage source is not an authenticated prior input')
    const prior = priorCorrectionStage(ref, request, histories, catalogues)
    if (!prior.ok) return prior
    if (!prior.value) return actionFailure('self-output', 'Correction stage source is not an authenticated prior input')
  }
  return { ok: true, value: true }
}
