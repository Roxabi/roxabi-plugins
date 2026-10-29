import { randomUUID } from 'node:crypto'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { NormalizationJudgement } from '../engine/uw-normalization-schema.ts'
import type { NativeBatch } from '../omp/review-runtime/contracts.ts'
import { actionRequest, type DeliveryCode, deliveryBatch, deliveryTask } from './delivery-action.ts'
import type { PreparedUwAction } from './uw-action-contract.ts'
import type { NormalizationProposalRequest, UwOperations, UwProposalInput } from './uw-contract.ts'
import { validateNormalizationConservation } from './uw-normalization-conservation.ts'

export function normalizationSourceDigest(request: NormalizationProposalRequest): string {
  return request.parsed.status === 'conformant' ? request.parsed.snapshot.raw.bodySha256 : request.parsed.raw.bodySha256
}

export function normalizationOperationId(request: NormalizationProposalRequest): string {
  return `uw-normalize:${request.uw.target}:${randomUUID()}`
}

export async function prepareNormalizationAction(input: {
  operations: UwOperations
  request: NormalizationProposalRequest
  operationId: string
  code: DeliveryCode
}): Promise<{ ok: true; value: PreparedUwAction } | { ok: false; reason: string }> {
  const prepared = await input.operations.prepareAction(
    actionRequest({
      actionId: input.operationId,
      purpose: 'normalize',
      subject: { kind: 'uw', uw: input.request.uw, pullRequest: null, binding: null },
      code: input.code,
    }),
  )
  return prepared.ok
    ? { ok: true, value: prepared.value }
    : { ok: false, reason: prepared.diagnostics[0]?.code ?? 'prepare-action-unavailable' }
}

export function normalizationDeliveryBatch(operationId: string, prepared: PreparedUwAction): NativeBatch {
  return deliveryBatch(
    operationId,
    [
      deliveryTask({
        name: 'R-uw-normalize',
        agent: 'R-uw-normalize',
        procedure:
          'Return the typed uw-normalization proposal from the supplied index only. Do not write or invent scope.',
        solutionSpace: 'one typed normalization judgement; no IDs, writes, or freeform scope',
        prepared,
      }),
    ],
    'omp-build workflow action',
  )
}

export function normalizationInput(
  request: NormalizationProposalRequest,
  judgement: NormalizationJudgement,
): UwProposalInput {
  return {
    uw: request.uw,
    sourceBodySha256: normalizationSourceDigest(request),
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
