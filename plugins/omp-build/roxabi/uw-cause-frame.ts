import type { CauseSisterInput, CreationContext, ReportPromotionInput } from '../engine/cause-disposition-schema.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import { hash } from './uw-cause-creation-support.ts'
import { frameSister } from './uw-cause-operations.ts'

type Parent = NonNullable<Extract<CreationContext, { kind: 'sister' }>['parentObservation']>
type Source = Extract<CanonicalRecord, { kind: 'cause-disposition' }>
export function buildCauseFrame(
  source: Source,
  request: CauseSisterInput | ReportPromotionInput,
  mode: 'sister' | 'report-promotion',
  parentScope: Scope | null,
  parent: Parent | null,
  originalDigest: string,
) {
  const ref = mode === 'sister' ? (request as CauseSisterInput).disposition : (request as ReportPromotionInput).report
  const createInput =
    mode === 'sister'
      ? frameSister(source, request as CauseSisterInput, parentScope)
      : structuredClone((request as ReportPromotionInput).create)
  if (
    createInput.draft.criteria.length === 0 ||
    createInput.draft.criteria.some((item) => item.kind !== 'new') ||
    createInput.draft.invariants.some((item) => item.kind !== 'new') ||
    createInput.normalization.length !== 0
  )
    throw new Error('cause-creation-framing-invalid')
  const relation =
    source.payload.outcome.state === 'final' && source.payload.outcome.disposition === 'sister-blocking'
      ? ('original-blocked-by-sister' as const)
      : ('sister-blocked-by-original' as const)
  const context: CreationContext =
    mode === 'sister'
      ? {
          kind: 'sister',
          disposition: ref,
          dispositionDigest: hash(source),
          original: ref.scope,
          originalObservationDigest: originalDigest,
          parent: parentScope,
          parentObservation: parent,
          relation,
        }
      : {
          kind: 'report-promotion',
          report: ref,
          reportDigest: hash(source),
          reason: (request as ReportPromotionInput).reason,
          parentObservation: parent,
        }
  return { createInput, relation, context }
}
