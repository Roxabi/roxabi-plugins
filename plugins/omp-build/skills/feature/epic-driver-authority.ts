import type { AcceptedOwnSpec } from '../../engine/workflow-accepted-spec-types.ts'
import type { MandateRecord } from '../../engine/workflow-control.ts'
import type { AcceptedChildCommitment } from '../../engine/workflow-mandate-schema.ts'
import { Refused } from './epic-driver-runtime'
import { BASE_NAME, RUN_ID } from './epic-naming'

export function evidenceText(evidence: readonly { message?: string }[] | undefined): string {
  return (
    evidence
      ?.map((item) => item.message)
      .filter(Boolean)
      .join('; ') || 'mandate refused'
  )
}

type ConfirmedEpicMandate = {
  mandateId: string
  run: string
  base: string
  children: readonly AcceptedChildCommitment[]
}

/**
 * Projects immutable mandate identity and current authenticated own-Spec state.
 * This establishes no active continuation, landing, or config compatibility.
 */
export function confirmedEpicMandate(record: MandateRecord, accepted: AcceptedOwnSpec): ConfirmedEpicMandate {
  const payload = record.payload
  if (payload.role === 'fix-only') throw new Refused(`mandate ${record.recordId} is fix-only, not normal authority`)
  if (typeof payload.run !== 'string' || !RUN_ID.test(payload.run)) {
    throw new Refused(`mandate ${record.recordId} run is not an 8-character id`)
  }
  if (typeof payload.base !== 'string' || !BASE_NAME.test(payload.base) || payload.base.includes('..')) {
    throw new Refused(`mandate ${record.recordId} base is not a branch name`)
  }
  const { config } = payload
  if (
    typeof config.productVersion !== 'string' ||
    typeof config.version !== 'string' ||
    typeof config.digest !== 'string' ||
    !('effective' in config)
  ) {
    throw new Refused(`mandate ${record.recordId} config identity is incomplete`)
  }
  return {
    mandateId: record.recordId,
    run: payload.run,
    base: payload.base,
    children: accepted.children,
  }
}
