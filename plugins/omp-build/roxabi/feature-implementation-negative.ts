import { randomUUID } from 'node:crypto'
import { producerImplementationOutputSchema } from '../dist/contracts.js'
import type { NativeBatchResult } from '../omp/review-runtime/contracts.ts'
import { matchesContextNegative } from './feature-context-negative.ts'
import type { FeatureNativePublication } from './feature-contract.ts'
import { publishRecord } from './feature-engine.ts'
import { claimedToolCallIds } from './feature-implementation-receipt.ts'
import { implementNativeOutcome } from './feature-native-outcome.ts'
import type { ImplementationResultBinding } from './feature-result-binding.ts'

export async function publishImplementationNegative(
  binding: ImplementationResultBinding,
  input: { cwd: string; result: NativeBatchResult },
): Promise<FeatureNativePublication> {
  if (input.result.canPublishContext?.() !== true)
    return { published: false, retained: false, reason: 'publication-ownership-revoked' }
  const child = binding.child
  if (!child || !matchesContextNegative(child, binding.start.payload.actionId, binding.start.payload.inputs))
    return { published: false, retained: false, reason: 'action-context-binding-mismatch' }
  const parsed = producerImplementationOutputSchema.safeParse(child.structured)
  if (!parsed.success || parsed.data.outcome !== 'blocked' || parsed.data.missing === undefined)
    return { published: false, retained: false, reason: 'implementation-output-invalid' }
  const recordId = randomUUID()
  const published = await publishRecord(
    binding.loaded,
    binding.history,
    {
      repository: binding.receiptScope.repository,
      target: binding.receiptScope.target,
      version: 1,
      recordId,
      runId: randomUUID(),
      operationId: `${input.result.batch.operationId}:result`,
      kind: 'action-receipt',
      payload: {
        format: 'omp-build-action-receipt/2',
        phase: 'result',
        action: 'implement',
        actionId: input.result.batch.operationId,
        mandate: binding.mandate,
        start: { scope: binding.receiptScope, recordId: binding.start.recordId, kind: 'action-receipt' },
        inputs: binding.start.payload.inputs,
        exactInputs: binding.exactInputs,
        native: implementNativeOutcome(child, true, claimedToolCallIds(child).ids),
        structured: parsed.data,
        admission: null,
        diagnostics: [],
      },
    },
    binding.gh,
    input.cwd,
    binding.publicationParents,
    input.result.canPublishContext,
  )
  return published.ok
    ? {
        published: false,
        retained: true,
        reason: 'action-context-missing',
        receipt: { scope: binding.receiptScope, recordId, kind: 'action-receipt' },
      }
    : { published: false, retained: false, reason: published.reason }
}
