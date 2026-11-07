import { acceptedActionInputs } from '../../testing/action-input-fixtures.ts'
import { actionInputDigest } from '../action-input.ts'
import type { ActionInputs, RecordInputRef } from '../action-input-schema.ts'
import type { CanonicalRecord } from '../record-schema.ts'
import type { SpecEffective } from '../spec-effective-schema.ts'
import type { AssessSpecExact } from '../workflow-receipt-schema.ts'
import { mechanicalSpecDelta } from '../workflow-spec-assessment.ts'

export function assessmentActionInputs(
  mandated: Extract<CanonicalRecord, { kind: 'mandate' }>,
  accepted: AssessSpecExact['accepted'],
  proposed: AssessSpecExact['proposed'],
  childOwnSources: AssessSpecExact['childOwnSources'],
  effective: SpecEffective,
  acceptedSources: RecordInputRef[],
  codeRange?: ActionInputs['manifest']['code'],
) {
  const exactInputs = {
    format: 'omp-build-spec-assessment/3' as const,
    accepted,
    proposed,
    attachedChildren: [],
    attachedWayfinders: [],
    childOwnSources,
    identityAllocations: mandated.payload.ownSpec.identityAllocations,
    mechanical: mechanicalSpecDelta(accepted, proposed),
  }
  const baseInputs = acceptedActionInputs(mandated, 'assess-spec', effective, codeRange)
  const manifest = {
    ...baseInputs.manifest,
    acceptedSources,
    spec: { kind: 'accepted' as const, effective },
    operands: { action: 'assess-spec' as const, origin: { kind: 'native-current' as const }, exactInputs },
  }
  const inputs = { ...baseInputs, manifest, fingerprint: actionInputDigest(manifest) }
  return { inputs, exactInputs }
}
