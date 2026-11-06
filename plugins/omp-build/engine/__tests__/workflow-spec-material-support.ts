import { canonicalValueDigest } from '../action-input.ts'
import { buildRecord } from '../record-construction.ts'
import type { ExternalRecordRef } from '../record-references.ts'
import type { CanonicalRecord } from '../record-schema.ts'
import { concreteAcceptedStateSchema } from '../workflow-mandate-schema.ts'
import { type MaterialAcceptanceProposal, materialAcceptanceDigest } from '../workflow-spec-assessment.ts'
import type { AssessmentState, assessFixture } from './workflow-spec-assessment-support.ts'
import { must } from './workflow-test-support.ts'

type FixtureAssessment = ReturnType<typeof assessFixture>

function recordRef(record: CanonicalRecord): ExternalRecordRef {
  return {
    scope: { repository: record.repository, target: record.target },
    recordId: record.recordId,
    kind: record.kind,
  }
}
export function assessmentState(assessment: FixtureAssessment): AssessmentState {
  const proposed = concreteAcceptedStateSchema.parse(assessment.proposed)
  return {
    ref: {
      uw: assessment.result.payload.exactInputs.accepted.ref.uw,
      version: assessment.proposed.snapshot.spec.version,
      sourceAccepted: recordRef(assessment.result),
    },
    ...proposed,
  }
}

export function materialControl(
  mandated: CanonicalRecord,
  id: string,
  assessment: FixtureAssessment,
  predecessor: ExternalRecordRef,
) {
  if (mandated.kind !== 'mandate') throw new Error('Material control fixture requires a mandate')
  const scope = { repository: mandated.repository, target: mandated.target }
  const exactInputs = assessment.result.payload.exactInputs
  const mandateRef = recordRef(mandated)
  const predecessorRef = predecessor
  const assessmentRef = recordRef(assessment.result)
  if (assessment.classification !== 'material' && assessment.classification !== 'unknown')
    throw new Error('Material control fixture requires a material or unknown assessment')
  const proposal: MaterialAcceptanceProposal = {
    format: 'omp-build-material-acceptance/2',
    operationId: `op-${id}`,
    uw: assessment.result.payload.exactInputs.accepted.ref.uw,
    mandate: mandateRef,
    predecessor: predecessorRef,
    assessment: assessmentRef,
    classification: assessment.classification,
    exactInputs,
  }
  const digest = materialAcceptanceDigest(proposal)
  const control = must(
    buildRecord({
      version: 1,
      repository: scope.repository,
      target: scope.target,
      recordId: id,
      runId: 'run-1',
      operationId: `op-${id}`,
      kind: 'operator-control',
      payload: {
        control: 'accept-material',
        controlId: id,
        mandate: mandateRef,
        predecessor: predecessorRef,
        assessment: assessmentRef,
        specVersion: assessment.proposed.snapshot.spec.version,
        proposalDigest: digest,
        authorization: { kind: 'direct' },
        confirmation: {
          route: 'omp-native-command',
          operationId: `op-${id}`,
          proposalDigest: digest,
          confirmedAt: '2026-10-21T00:00:00Z',
        },
        identityDelta: { retired: exactInputs.mechanical.removed },
      },
    }),
  )
  return control
}

export function materialState(assessment: FixtureAssessment, control: CanonicalRecord): AssessmentState {
  const proposed = concreteAcceptedStateSchema.parse(assessment.proposed)
  const prior = assessment.result.payload.exactInputs.accepted
  const sameOwn =
    prior.tier === proposed.tier &&
    canonicalValueDigest(prior.inheritedOwnSpecRefs) === canonicalValueDigest(proposed.inheritedOwnSpecRefs) &&
    canonicalValueDigest({ ...prior.snapshot, raw: { ...prior.snapshot.raw, lastEditedAt: null } }) ===
      canonicalValueDigest({ ...proposed.snapshot, raw: { ...proposed.snapshot.raw, lastEditedAt: null } })
  return {
    ...proposed,
    snapshot: sameOwn ? prior.snapshot : proposed.snapshot,
    ref: sameOwn
      ? prior.ref
      : { uw: prior.ref.uw, version: proposed.snapshot.spec.version, sourceAccepted: recordRef(control) },
  }
}
