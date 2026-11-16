import type { ActionInputManifest } from '../engine/action-input-schema.ts'
import { pullHistory } from './feature-ci-review-fixture.ts'
import type { Box } from './sandbox/sandbox-types.ts'

/** Canonical, post-publication observations only; transient callback eligibility is host-owned. */
export function adoptionProofDiagnostic(box: Box, manifest: ActionInputManifest, error: unknown): string {
  const history = pullHistory(box)
  const fixes = history.operations.flatMap((entry) =>
    entry.status === 'complete' && entry.record?.kind === 'fix-result'
      ? [
          {
            recordId: entry.record.recordId,
            runId: entry.record.runId,
            candidateGitSHA: entry.record.payload.candidateGitSHA,
            criterionReceipt: entry.record.payload.criterionReceipt ?? null,
          },
        ]
      : [],
  )
  const corrections = history.operations.flatMap((entry) =>
    entry.status === 'complete' && entry.record?.kind === 'correction-result'
      ? [
          {
            recordId: entry.record.recordId,
            causeId: entry.record.payload.causeId,
            outcome: entry.record.payload.outcome,
            attempt: entry.record.payload.attempt,
            commitSHAs: entry.record.payload.commitSHAs,
            appliedContributionId: entry.record.payload.appliedContributionId,
            criterionObservations: entry.record.payload.criterionObservations,
          },
        ]
      : [],
  )
  const contributions = history.operations.flatMap((entry) => {
    if (
      entry.status !== 'complete' ||
      entry.record?.kind !== 'contribution' ||
      entry.record.payload.host.phase !== 'fix'
    )
      return []
    const { host, native, structured } = entry.record.payload
    const criteria =
      structured && typeof structured === 'object' && !Array.isArray(structured) ? structured.criteria : undefined
    return [
      {
        recordId: entry.record.recordId,
        host,
        completion: native?.completion,
        strict: native?.strict,
        observation: native?.observation
          ? {
              childId: native.observation.childId,
              actionId: native.observation.actionId,
              submissionIndex: native.observation.submissionIndex,
            }
          : null,
        criteria,
      },
    ]
  })
  const delivery = manifest.deliveryData.map((item) => ({ role: item.role, record: item.record }))
  return `adoption-final-spec-source:${JSON.stringify({ error: String(error), code: manifest.code, delivery, fixes, corrections, contributions })}`
}
