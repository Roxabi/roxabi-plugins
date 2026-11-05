import { buildRecord, type RecordDraft, type Scope } from '../dist/contracts.js'
import type { NativeChildResult } from '../omp/review-runtime/contracts'
import { nativeContributionPayload } from './native-contribution'
import { type createReviewIdentity, type ReviewSlot, recordBase, requireRecord } from './review-records'

export function buildReviewContribution(
  identity: ReturnType<typeof createReviewIdentity>,
  scope: Scope,
  recordId: string,
  slot: ReviewSlot | null,
  child: NativeChildResult,
  inventoryId: string,
) {
  return requireRecord(
    buildRecord({
      ...recordBase(identity, scope, recordId),
      kind: 'contribution',
      payload: nativeContributionPayload(slot, child, inventoryId, recordId, 'findings'),
    } satisfies Extract<RecordDraft, { kind: 'contribution' }>),
    'contribution',
  )
}
