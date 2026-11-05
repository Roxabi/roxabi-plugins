import { type ActionInputs, type CauseContext, sameOwnSpecRef } from '../dist/contracts.js'
import { type FixActionResult, failure } from './fix-contract.ts'

/** Check the prepared native action against the independently resolved original UW. */
export function validateCorrectionOrigin(
  manifest: ActionInputs['manifest'],
  causeContext: CauseContext,
): FixActionResult<void> {
  if (manifest.subject.kind !== 'uw' || manifest.spec.kind !== 'accepted')
    return failure('correction-spec-not-accepted')
  if (
    manifest.subject.uw.repository !== causeContext.original.repository ||
    manifest.subject.uw.target !== causeContext.original.target
  )
    return failure('correction-origin-mismatch')
  if (!sameOwnSpecRef(manifest.spec.effective.own, causeContext.effective.own))
    return failure('correction-origin-stale')
  return { ok: true, value: undefined }
}
