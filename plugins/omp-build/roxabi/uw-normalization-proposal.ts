import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { NormalizationJudgement } from '../engine/uw-normalization-schema.ts'
import type { NormalizationProposalRequest, UwProposalInput } from './uw-contract.ts'
import { validateNormalizationConservation } from './uw-normalization-conservation.ts'

export function normalizationInput(
  request: NormalizationProposalRequest,
  judgement: NormalizationJudgement,
): UwProposalInput {
  return {
    uw: request.uw,
    sourceBodySha256:
      request.parsed.status === 'conformant' ? request.parsed.snapshot.raw.bodySha256 : request.parsed.raw.bodySha256,
    title: request.title,
    writes: request.writes,
    draft: judgement.draft,
    factors: judgement.factors,
    normalization: judgement.normalization,
    tierOverride: judgement.tierOverride,
  }
}

export function validateNormalizationJudgement(
  request: NormalizationProposalRequest,
  judgement: NormalizationJudgement,
): readonly UwDiagnostic[] {
  return validateNormalizationConservation(normalizationInput(request, judgement), request.parsed.analysis)
}
