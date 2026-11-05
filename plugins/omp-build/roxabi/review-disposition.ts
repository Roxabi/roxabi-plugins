import { isDeepStrictEqual } from 'node:util'
import type { CanonicalRecord, DecodedHistory, DispositionSource, GitHubOptions, Ref } from '../dist/contracts.js'
import { persistCauseDispositions } from './fix-disposition-execution.ts'
import { createFixDispositionStore } from './fix-disposition-store.ts'
import { resolveFixOrigin } from './fix-origin.ts'
import type { PreparedReviewInputs } from './review-contract.ts'
import type { createReviewIdentity } from './review-records.ts'

async function persistReviewSource(
  input: PreparedReviewInputs,
  options: GitHubOptions,
  identity: ReturnType<typeof createReviewIdentity>,
  source: DispositionSource,
): Promise<Ref<'cause-disposition'>[]> {
  const manifest = input.inputSnapshot.manifest
  if (manifest.subject.kind === 'standalone-pr' && manifest.spec.kind === 'absent') return []
  if (manifest.subject.kind !== 'uw' || manifest.spec.kind !== 'accepted')
    throw new Error('review-disposition-refused:correction-original-uw-required')
  const origin = await resolveFixOrigin(manifest.subject.uw, input.operations)
  if (!origin.ok) throw new Error(`review-disposition-refused:${origin.diagnostics.join(',')}`)
  if (!isDeepStrictEqual(origin.value.effective, manifest.spec.effective))
    throw new Error('review-disposition-refused:correction-origin-stale')
  const retained = await persistCauseDispositions(
    { causeContext: origin.value },
    source,
    { runId: identity.runId, operationId: identity.operationId, nextRecordId: (kind) => identity.next(kind) },
    createFixDispositionStore(origin.value.original, options),
  )
  if (!retained.ok) throw new Error(`review-disposition-refused:${retained.diagnostics.join(',')}`)
  return retained.value.refs
}

function retainedReviewContributions(history: DecodedHistory, inventories: readonly string[]) {
  return history.operations.flatMap((operation) => {
    const record = operation.record
    return operation.status === 'complete' &&
      operation.authority !== 'foreign' &&
      record?.kind === 'contribution' &&
      record.payload.inventoryId !== null &&
      inventories.includes(record.payload.inventoryId)
      ? [record]
      : []
  })
}

export function reviewDispositionHandlers(
  input: PreparedReviewInputs,
  options: GitHubOptions,
  identity: ReturnType<typeof createReviewIdentity>,
  inventories: readonly string[],
) {
  return {
    persistDecision: (decision: Extract<CanonicalRecord, { kind: 'decision' }>) =>
      persistReviewSource(input, options, identity, { kind: 'decision', decision }),
    retainFailedSynthesis: async (history: DecodedHistory, diagnostic: string) => {
      await persistReviewSource(input, options, identity, {
        kind: 'retained-output',
        contributions: retainedReviewContributions(history, inventories),
        diagnostics: [{ code: diagnostic, message: diagnostic }],
      })
    },
  }
}
