import { acceptedActionInputs } from '../../testing/action-input-fixtures.ts'
import { actionInputDigest } from '../action-input.ts'
import type { CanonicalRecord } from '../record-schema.ts'
import type { SpecEffective } from '../spec-effective.ts'
import type { AssessSpecExact } from '../workflow-receipt-schema.ts'
import { mechanicalSpecDelta } from '../workflow-spec-assessment.ts'

export function assessmentActionInputs(
  mandated: Extract<CanonicalRecord, { kind: 'mandate' }>,
  accepted: AssessSpecExact['accepted'],
  proposed: AssessSpecExact['proposed'],
) {
  const exactInputs = {
    format: 'omp-build-spec-assessment/2' as const,
    accepted,
    proposed,
    identityAllocations: mandated.payload.ownSpec.identityAllocations,
    mechanical: mechanicalSpecDelta(accepted, proposed),
  }
  const baseInputs = acceptedActionInputs(mandated, 'assess-spec')
  const spec = baseInputs.manifest.spec
  if (spec.kind !== 'accepted') throw new Error('expected accepted Spec fixture')
  const effective: SpecEffective = {
    ...spec.effective,
    own: accepted.ref,
    versionVector: [accepted.ref],
    spec: accepted.snapshot.spec,
  }
  const manifest = {
    ...baseInputs.manifest,
    spec: { kind: 'accepted' as const, effective },
    operands: { action: 'assess-spec' as const, exactInputs },
  }
  const inputs = { ...baseInputs, manifest, fingerprint: actionInputDigest(manifest) }
  return { inputs, exactInputs }
}
