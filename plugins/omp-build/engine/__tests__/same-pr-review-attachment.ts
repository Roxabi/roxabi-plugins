import { actionInputDigest } from '../action-input.ts'
import type { ActionInputs } from '../action-input-schema.ts'
import type { CriterionVerdict } from '../criterion-verdict-schema.ts'
import type { DecodedHistory } from '../history-schema.ts'
import { parseRecord } from '../record-construction.ts'
import type { CanonicalRecord } from '../record-schema.ts'
import {
  captureSamePrSubmission,
  replaceSamePrSourceContributions,
  samePrReviewInventories,
} from './same-pr-submission-fixture.ts'
/** Replace one fixture review graph without changing its record or operation identities. */
export function attachReviewInputs(
  history: DecodedHistory,
  reviewId: string,
  inputs: ActionInputs,
  verdict: CriterionVerdict,
): DecodedHistory {
  const records = history.operations.flatMap((entry) => (entry.record === null ? [] : [entry.record]))
  const review = records.find((record) => record.recordId === reviewId)
  if (review?.kind !== 'review') throw new Error('review fixture not found')
  const { root, synthesis } = samePrReviewInventories(records, review)
  const decision = records.find((record) => record.recordId === review.payload.decisionId)
  if (decision?.kind !== 'decision' || decision.payload.judgment.purpose !== 'review')
    throw new Error('expected review decision')
  const source = records.filter(
    (record) =>
      record.kind === 'contribution' && decision.payload.judgment.sourceContributionIds.includes(record.recordId),
  )
  const spec = source.find((record) => record.kind === 'contribution' && record.payload.host.phase === 'spec')
  const synthesisContribution = records.find((record) => record.recordId === decision.payload.originalContributionId)
  if (spec?.kind !== 'contribution' || synthesisContribution?.kind !== 'contribution')
    throw new Error('expected spec and synthesis contributions')
  const digest = actionInputDigest(inputs.manifest)
  if (inputs.fingerprint !== digest) throw new Error('review input fingerprint does not match manifest')
  const actions = new Map(
    root.payload.slots.map((slot) => [
      slot.slotId,
      { actionId: slot.action?.actionId ?? `${root.recordId}-${slot.slotId}`, inputs },
    ]),
  )
  const specSlot = root.payload.slots.find((slot) => slot.phase === 'spec')
  if (specSlot === undefined || spec.payload.host.slotId !== specSlot.slotId)
    throw new Error('spec contribution must match an allocated spec slot')
  const judgment = {
    ...decision.payload.judgment,
    criterionVerdicts: [{ contributionId: spec.recordId, target: verdict.target }],
  }
  const specOutput = { findings: [], specRows: [verdict] }
  const replacements = new Map<string, CanonicalRecord>()
  const replace = (record: unknown) => {
    const parsed = parseRecord(record)
    if (!parsed.ok) throw new Error(`invalid review fixture record: ${JSON.stringify(parsed.diagnostics)}`)
    replacements.set(parsed.value.recordId, parsed.value)
  }
  replace({
    ...root,
    payload: {
      ...root.payload,
      candidateGitSHA: inputs.manifest.code.head,
      input: digest,
      actionInputDigest: digest,
      inputSnapshot: inputs,
      slots: root.payload.slots.map((slot) => ({
        ...slot,
        ...(slot.slotId === specSlot.slotId ? { role: 'R-review-spec' } : {}),
        action: actions.get(slot.slotId),
      })),
    },
  })
  replace({
    ...synthesis,
    payload: {
      ...synthesis.payload,
      candidateGitSHA: inputs.manifest.code.head,
      input: digest,
      actionInputDigest: digest,
      slots: synthesis.payload.slots.map((slot) => ({
        ...slot,
        action: { actionId: slot.action?.actionId ?? synthesis.recordId, inputs },
      })),
    },
  })
  replaceSamePrSourceContributions(source, actions, spec.recordId, specOutput, replace)
  replace({ ...decision, payload: { ...decision.payload, judgment } })
  replace({
    ...synthesisContribution,
    payload: {
      ...synthesisContribution.payload,
      structured: judgment,
      rawAttempts: captureSamePrSubmission(synthesisContribution.payload.rawAttempts, judgment),
    },
  })
  replace({ ...review, payload: { ...review.payload, candidateGitSHA: inputs.manifest.code.head, input: digest } })
  return {
    ...history,
    operations: history.operations.map((entry) => ({
      ...entry,
      record: entry.record === null ? null : (replacements.get(entry.record.recordId) ?? entry.record),
    })),
  }
}
