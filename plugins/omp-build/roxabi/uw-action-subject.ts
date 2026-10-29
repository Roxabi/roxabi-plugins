import { canonicalValueDigest } from '../engine/action-input.ts'
import type { UwActionRequest } from './uw-action-contract.ts'

/** A null request binding asks the host to resolve authority; it is not a resolved binding. */
export function matchesRequestedSubject(
  prior: UwActionRequest['subject'],
  current: UwActionRequest['subject'],
): boolean {
  if (prior.kind !== current.kind) return false
  if (prior.kind === 'standalone-pr' || current.kind === 'standalone-pr') {
    return canonicalValueDigest(prior.pullRequest) === canonicalValueDigest(current.pullRequest)
  }
  return (
    canonicalValueDigest(prior.uw) === canonicalValueDigest(current.uw) &&
    canonicalValueDigest(prior.pullRequest) === canonicalValueDigest(current.pullRequest) &&
    (current.binding === null || canonicalValueDigest(prior.binding) === canonicalValueDigest(current.binding))
  )
}
