import type { ActionInputs } from './action-input-schema.ts'
import { equalScope } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'

type ReviewRoot = Extract<
  Extract<CanonicalRecord, { kind: 'review-attempt' }>['payload'],
  { stage: 'initial'; purpose: 'review' }
>
/** Structural shape only; the selected receipt is authenticated separately. */
export function hasIntegrationReviewPin(inputs: ActionInputs): boolean {
  const pins = inputs.manifest.deliveryData.filter((item) => item.role === 'integration')
  const pin = pins[0]
  const subject = inputs.manifest.subject
  return (
    pins.length === 1 &&
    pin !== undefined &&
    pin.record.kind === 'action-receipt' &&
    pin.selector === '/payload/structured/code' &&
    subject.kind === 'uw' &&
    equalScope(pin.record.scope, subject.uw)
  )
}

/** Bind a review root's actual scope and review mode to its immutable action inputs. */
export function reviewSubjectBound(
  record: Extract<CanonicalRecord, { kind: 'review-attempt' }>,
  root: ReviewRoot,
): boolean {
  const { subject, spec, code, purpose } = root.inputSnapshot.manifest
  const scope = subject.kind === 'uw' ? (subject.pullRequest ?? subject.uw) : subject.pullRequest
  if (
    purpose !== 'review' ||
    !equalScope(record, scope) ||
    code.repository !== scope.repository ||
    code.head !== root.candidateGitSHA
  )
    return false
  if (root.subject.kind === 'epic-range') {
    return (
      subject.kind === 'uw' &&
      subject.pullRequest === null &&
      subject.binding === null &&
      spec.kind === 'accepted' &&
      root.subject.range === `${code.base}..${code.head}`
    )
  }
  return (
    (subject.kind === 'uw' && subject.pullRequest !== null && subject.binding !== null && spec.kind === 'accepted') ||
    (subject.kind === 'standalone-pr' && spec.kind === 'absent')
  )
}
