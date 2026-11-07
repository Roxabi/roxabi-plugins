import { hasIntegrationReviewPin } from '../engine/review-subject-binding.ts'
import type { PreparedReviewInputs } from './review-contract'
import type { PreparedUwAction } from './uw-action-contract.ts'

export function requireInitialReviewAction(input: PreparedReviewInputs, specAction: PreparedUwAction): void {
  if (input.chunks.length !== 0) return
  const subject = input.context.subject
  const code = specAction.inputs.manifest.code
  if (
    subject.kind !== 'epic-range' ||
    !hasIntegrationReviewPin(specAction.inputs) ||
    subject.range !== `${code.base}..${code.head}` ||
    code.referenceCommit !== code.head
  )
    throw new Error('review-action-unprepared')
}
